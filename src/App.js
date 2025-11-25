import React, { useState } from 'react';
import './App.css';

function App() {
  const [emailFiles, setEmailFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [processedEmails, setProcessedEmails] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const [customValues, setCustomValues] = useState({
    rp: 'RP',
    rdns: 'RDNS',
    advunsub: 'ADVUNSUB',
    to: '*To',
    date: '*DATE'
  });
  const [activeEmailIndex, setActiveEmailIndex] = useState(0);

  // Exact headers to remove (only these specific ones)
  const headersToRemove = [
    'X-MS-Exchange-Transport-CrossTenantHeadersStamped',
    'X-sib-id','List-Unsubscribe','List-Unsubscribe-Post',
    'X-CSA-Complaints',
    'sender','X-Mailin-EID',
    'X-Forwarded-Encrypted',
    'Delivered-To',
    'Received: by',  // Only "Received: by" not "Received: from"
    'X-Google-Smtp-Source',
    'X-Received',
    'X-original-To',
    'ARC-Seal',
    'ARC-Message-Signature',
    'ARC-Authentication-Results',
    'Return-Path',
    'Received-SPF',
    'References',
    'Authentication-Results',
    'DKIM-Signature',
    'X-SG-EID',
    'Cc',
    'X-Entity-ID'
  ];

  const handleCustomValueChange = (key, value) => {
    setCustomValues(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleFileUpload = (event) => {
    const files = Array.from(event.target.files);
    
    const newEmailFiles = files.map(file => ({
      file,
      name: file.name,
      size: file.size,
      status: 'pending', // pending, processing, completed, error
      originalContent: '',
      filteredContent: '',
      headers: [],
      body: '',
      error: null
    }));
    
    setEmailFiles(prev => [...prev, ...newEmailFiles]);
    event.target.value = ''; // Reset file input
  };

  const readFileContent = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e);
      reader.readAsText(file);
    });
  };

  // New helper function to find the header-body separator more robustly
  const findHeaderBodySeparator = (content) => {
    // Normalize line endings
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Method 1: Look for double newline (standard)
    const doubleNewline = normalized.indexOf('\n\n');
    if (doubleNewline !== -1) {
      // Verify this isn't just a multi-line header continuation
      const before = normalized.substring(0, doubleNewline);
      const after = normalized.substring(doubleNewline + 2);
      
      // If after the double newline we have header-like content, continue searching
      if (after.trim() && after.split('\n')[0].match(/^[A-Za-z][A-Za-z0-9-]*:\s*/)) {
        // This might be a false positive, continue searching
        const nextDoubleNewline = normalized.indexOf('\n\n', doubleNewline + 2);
        if (nextDoubleNewline !== -1) {
          return nextDoubleNewline + 2;
        }
      } else {
        return doubleNewline + 2;
      }
    }
    
    // Method 2: Look for pattern where headers end and body begins
    const lines = normalized.split('\n');
    let inHeaders = true;
    let headerEndIndex = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (!line) {
        // Empty line - likely the header/body separator
        if (inHeaders) {
          headerEndIndex = lines.slice(0, i + 1).join('\n').length;
          inHeaders = false;
        }
        continue;
      }
      
      // Check if this looks like a header line
      const isHeader = line.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/);
      
      if (inHeaders && !isHeader) {
        // We were in headers but found a non-header line
        // This might be the start of the body
        headerEndIndex = lines.slice(0, i).join('\n').length;
        break;
      }
      
      if (!inHeaders && isHeader) {
        // We found a header after supposedly being in body - reset
        inHeaders = true;
        headerEndIndex = 0;
      }
    }
    
    if (headerEndIndex > 0) {
      return headerEndIndex;
    }
    
    // Method 3: Fallback - assume headers are everything until first non-header line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/) && !line.match(/^\s/)) {
        return lines.slice(0, i).join('\n').length;
      }
    }
    
    return -1; // No clear separator found
  };

  const extractFromName = (fromHeader) => {
    if (!fromHeader) return '';
    
    const nameMatch = fromHeader.match(/^From:\s*"([^"]+)"\s*<[^>]+>$/i) || 
                     fromHeader.match(/^From:\s*([^<]+)\s*<[^>]+>$/i);
    
    if (nameMatch && nameMatch[1]) {
      return nameMatch[1].trim();
    }
    
    return '';
  };

  const modifyFromHeader = (fromHeader, rpValue) => {
    if (!fromHeader) return 'From: <info@[' + rpValue + ']>';
    
    const fromName = extractFromName(fromHeader);
    if (fromName) {
      return `From: "${fromName}" <info@[${rpValue}]>`;
    } else {
      return `From: <info@[${rpValue}]>`;
    }
  };

  const insertEIDIntoMessageId = (messageId) => {
    if (!messageId) return messageId;
    
    const messageIdMatch = messageId.match(/^Message-ID:\s*(<[^>]+>)/i);
    if (!messageIdMatch) return messageId;
    
    const fullMessageId = messageIdMatch[0];
    const messageIdValue = messageIdMatch[1];
    
    const messageIdContent = messageIdValue.substring(1, messageIdValue.length - 1);
    
    const atIndex = messageIdContent.lastIndexOf('@');
    if (atIndex === -1) return messageId;
    
    const lastDotIndex = messageIdContent.lastIndexOf('.', atIndex);
    
    let insertPosition;
    if (lastDotIndex !== -1) {
      insertPosition = lastDotIndex;
    } else {
      insertPosition = atIndex;
    }
    
    const modifiedContent = 
      messageIdContent.substring(0, insertPosition) + 
      '[EID]' + 
      messageIdContent.substring(insertPosition);
    
    return `Message-ID: <${modifiedContent}>`;
  };

  const addUnsubscribeHeaders = (rdnsValue, advunsubValue) => {
    return [
      `List-Unsubscribe: <mailto:unsubscribe@[${rdnsValue}]>, <http://[${rdnsValue}]/[${advunsubValue}]>`,
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
    ];
  };

  const modifyToHeader = (toHeader, toValue) => {
    return `To: [${toValue}]`;
  };

  const modifyDateHeader = (dateHeader, dateValue) => {
    return `Date: [${dateValue}]`;
  };

  const processSingleEmail = (emailContent) => {
    if (!emailContent.trim()) {
      throw new Error('Empty email content');
    }

    // Normalize line endings
    let normalizedContent = emailContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Find header-body separator
    const headerEndIndex = findHeaderBodySeparator(normalizedContent);
    
    if (headerEndIndex === -1) {
      // Last resort: try to parse line by line
      const lines = normalizedContent.split('\n');
      let headerLines = [];
      let bodyLines = [];
      let inHeaders = true;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        if (inHeaders) {
          if (trimmedLine === '') {
            // Empty line marks end of headers
            inHeaders = false;
            continue;
          }
          
          // Check if this looks like a header
          if (trimmedLine.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/) || 
              (headerLines.length > 0 && line.match(/^\s/))) {
            // Header line or continuation
            headerLines.push(line);
          } else {
            // Doesn't look like a header, probably start of body
            inHeaders = false;
            bodyLines.push(line);
          }
        } else {
          bodyLines.push(line);
        }
      }
      
      if (headerLines.length === 0) {
        throw new Error('No headers found in email content');
      }
      
      const headersSection = headerLines.join('\n');
      const bodySection = bodyLines.join('\n');
      
      return processHeadersAndBody(headersSection, bodySection);
    }

    const headersSection = normalizedContent.substring(0, headerEndIndex).trim();
    const bodySection = normalizedContent.substring(headerEndIndex).trim();

    return processHeadersAndBody(headersSection, bodySection);
  };

  const processHeadersAndBody = (headersSection, bodySection) => {
    if (!headersSection) {
      throw new Error('No headers found in email');
    }

    // Process headers with improved multi-line handling
    const headerLines = headersSection.split('\n');
    const processedHeaders = [];
    let currentHeader = '';

    headerLines.forEach((line) => {
      // Skip completely empty lines
      if (line.trim() === '') {
        return;
      }

      // Check if this line starts a new header
      if (line.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/)) {
        // If we have a current header being built, push it before starting new one
        if (currentHeader) {
          processedHeaders.push(currentHeader);
        }
        currentHeader = line;
      } 
      // Check if this is a continuation line (starts with whitespace or is empty)
      else if (currentHeader && (line.match(/^\s/) || line === '')) {
        // Continue the current header
        currentHeader += '\n' + line;
      }
      // If we encounter a non-header line that's not a continuation
      else {
        // This might be malformed content, but we'll treat it as a new header
        if (currentHeader) {
          processedHeaders.push(currentHeader);
        }
        currentHeader = line;
      }
    });

    // Don't forget the last header
    if (currentHeader) {
      processedHeaders.push(currentHeader);
    }

    // Validate that we found some headers
    if (processedHeaders.length === 0) {
      throw new Error('No valid headers found in email');
    }

    // Apply modifications
    let modifiedHeaders = processedHeaders.map(header => {
      const headerName = header.split(':')[0].trim();
      
      if (headerName === 'Message-ID') {
        return insertEIDIntoMessageId(header);
      } else if (headerName === 'From') {
        return modifyFromHeader(header, customValues.rp);
      } else if (headerName === 'To') {
        return modifyToHeader(header, customValues.to);
      } else if (headerName === 'Date') {
        return modifyDateHeader(header, customValues.date);
      }
      return header;
    });

    // Remove specified headers
    modifiedHeaders = modifiedHeaders.filter(header => {
      const headerName = header.split(':')[0].trim();
      
      if (headerName === 'Received') {
        const headerValue = header.toLowerCase();
        if (headerValue.includes('received: by') || headerValue.includes('received by')) {
          return false;
        }
        return true;
      }
      
      return !headersToRemove.some(toRemove => {
        const cleanToRemove = toRemove.replace(': by', '').toLowerCase();
        return headerName.toLowerCase() === cleanToRemove;
      });
    });

    // Add unsubscribe headers
    const unsubscribeHeaders = addUnsubscribeHeaders(customValues.rdns, customValues.advunsub);
    modifiedHeaders.push(...unsubscribeHeaders);

    const filteredEmailContent = modifiedHeaders.join('\n') + '\n\n' + bodySection;

    return {
      headers: processedHeaders,
      body: bodySection,
      filteredEmail: filteredEmailContent
    };
  };

  const processAllEmails = async () => {
    if (emailFiles.length === 0) {
      alert('Please upload some .eml files first');
      return;
    }

    setProcessing(true);
    setProcessedEmails([]);
    
    const results = [];
    
    for (let i = 0; i < emailFiles.length; i++) {
      const emailFile = emailFiles[i];
      
      setEmailFiles(prev => prev.map((ef, index) => 
        index === i ? { ...ef, status: 'processing' } : ef
      ));
      
      try {
        const content = await readFileContent(emailFile.file);
        const processed = processSingleEmail(content);
        
        const result = {
          ...emailFile,
          status: 'completed',
          originalContent: content,
          filteredContent: processed.filteredEmail,
          headers: processed.headers,
          body: processed.body
        };
        
        results.push(result);
        
      } catch (error) {
        const result = {
          ...emailFile,
          status: 'error',
          error: error.message
        };
        results.push(result);
      }
      
      setEmailFiles(prev => prev.map((ef, index) => 
        index === i ? results[results.length - 1] : ef
      ));
    }
    
    setProcessedEmails(results);
    setProcessing(false);
    setShowResults(true);
    setActiveEmailIndex(0);
  };

  const isHeaderRemoved = (header) => {
    const headerName = header.split(':')[0].trim();
    
    if (headerName === 'Received') {
      const headerValue = header.toLowerCase();
      return headerValue.includes('received: by') || headerValue.includes('received by');
    }
    
    return headersToRemove.some(toRemove => {
      const cleanToRemove = toRemove.replace(': by', '').toLowerCase();
      return headerName.toLowerCase() === cleanToRemove;
    });
  };

  const isHeaderModified = (header) => {
    const headerName = header.split(':')[0].trim();
    return ['Message-ID', 'From', 'To', 'Date'].includes(headerName);
  };

  const isHeaderAdded = (header) => {
    const headerName = header.split(':')[0].trim();
    return ['List-Unsubscribe', 'List-Unsubscribe-Post'].includes(headerName);
  };

  const downloadEmail = (content, filename) => {
    const blob = new Blob([content], { type: 'message/rfc822' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.replace('.eml', '_modified.eml') || 'modified_email.eml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadAllEmails = () => {
    processedEmails.forEach(email => {
      if (email.status === 'completed') {
        downloadEmail(email.filteredContent, email.name);
      }
    });
  };

  const resetForm = () => {
    setEmailFiles([]);
    setProcessedEmails([]);
    setShowResults(false);
    setProcessing(false);
    setActiveEmailIndex(0);
    setCustomValues({
      rp: 'example.com',
      rdns: 'example.com',
      advunsub: 'unsubscribe',
      to: 'recipient@example.com',
      date: new Date().toGMTString()
    });
  };

  const removeFile = (index) => {
    setEmailFiles(prev => prev.filter((_, i) => i !== index));
  };

  const generateSampleEmail = () => {
    const sampleEmail = `Delivered-To: recipient@example.com
Received: by 2002:a05:6e10:2999:0:0:0:0 with SMTP id x25csp123456;
        Mon, 1 Jan 2024 12:00:00 -0800 (PST)
X-Received: by 2002:a17:90b:1234:: with SMTP id x123mr123456789.1.1234567890;
        Mon, 01 Jan 2024 12:00:00 -0800 (PST)
ARC-Seal: i=1; a=rsa-sha256; t=1234567890; cv=none;
        d=example.com; s=arc-2020;
ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=arc-2020;
ARC-Authentication-Results: i=1; mx.google.com;
Received: from mail.example.com (mail.example.com. [192.168.1.100])
        by mx.google.com with ESMTPS id x123abc456
        for <recipient@example.com>;
        Mon, 01 Jan 2024 12:00:00 -0800 (PST)
Received-SPF: pass (google.com: domain of sender@example.com designates 192.168.1.100 as permitted sender) client-ip=192.168.1.100;
Authentication-Results: mx.google.com;
       dkim=pass header.i=@example.com header.s=2020 header.b=ABC123;
       spf=pass (google.com: domain of sender@example.com designates 192.168.1.100 as permitted sender) smtp.mailfrom=sender@example.com;
       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;
        d=example.com; s=2020;
X-Google-Smtp-Source: ABC123def456
X-original-To: original@example.com
Return-Path: <bounce@example.com>
X-SG-EID: ABC123DEF456
X-Entity-ID: xyz789
Message-ID: <691d9608.050a0220.16c81e.716dSMTPIN_ADDED_BROKEN@mx.google.com>
From: "John Smith" <john.smith@original-domain.com>
To: "Jane Doe" <jane.doe@example.com>
Cc: "Bob Wilson" <bob.wilson@example.com>
Date: Mon, 1 Jan 2024 10:00:00 +0000
Subject: Test Email with Multiple Headers
References: <previous123@example.com>
Content-Type: text/plain; charset="utf-8"

This is the email body content.
It can have multiple lines.

This is a new paragraph in the body.

Best regards,
John Smith`;

    const sampleFile = new File([sampleEmail], "sample_email.eml", { type: "message/rfc822" });
    
    const newEmailFile = {
      file: sampleFile,
      name: "sample_email.eml",
      size: sampleEmail.length,
      status: 'pending',
      originalContent: '',
      filteredContent: '',
      headers: [],
      body: '',
      error: null
    };
    
    setEmailFiles(prev => [...prev, newEmailFile]);
  };

  const navigateToEmail = (index) => {
    setActiveEmailIndex(index);
    // Scroll to the top of the results section
    document.querySelector('.results-section')?.scrollIntoView({ behavior: 'smooth' });
  };

  const copyModifiedEmail = () => {
    if (processedEmails[activeEmailIndex] && processedEmails[activeEmailIndex].status === 'completed') {
      navigator.clipboard.writeText(processedEmails[activeEmailIndex].filteredContent);
      alert('Modified email copied to clipboard!');
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <div className="header-brand">
          <div className="company-logo">
            <span className="company-name">EMSL</span>
          </div>
          <div className="header-titles">
            <h1>Email Header Modifier</h1>
            <p>Process multiple .eml files - Remove headers, modify fields, and add unsubscribe headers</p>
          </div>
        </div>
        <div className="header-note">
          <small>Batch process multiple email files with custom values</small>
        </div>
      </header>

      <div className="container">
        <div className="input-section">
          <div className="editor-section">
            <h3>Upload .eml Files</h3>
            
            {/* File Upload Area */}
            <div className="file-upload-section">
              <input
                type="file"
                id="emailFiles"
                multiple
                accept=".eml"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
              <label htmlFor="emailFiles" className="file-upload-label">
                <div className="upload-area">
                  <div className="upload-icon">📧</div>
                  <div className="upload-text">
                    <strong>Click to select .eml files</strong>
                    <span>or drag and drop files here</span>
                  </div>
                  <div className="upload-hint">
                    Select multiple .eml files to process them all at once
                  </div>
                </div>
              </label>
              
              {/* File List */}
              {emailFiles.length > 0 && (
                <div className="file-list">
                  <h4>Selected Files ({emailFiles.length})</h4>
                  {emailFiles.map((emailFile, index) => (
                    <div key={index} className={`file-item ${emailFile.status}`}>
                      <div className="file-info">
                        <div className="file-name">{emailFile.name}</div>
                        <div className="file-size">({(emailFile.size / 1024).toFixed(2)} KB)</div>
                      </div>
                      <div className="file-actions">
                        <div className="file-status">
                          {emailFile.status === 'pending' && '⏳ Ready'}
                          {emailFile.status === 'processing' && '🔄 Processing...'}
                          {emailFile.status === 'completed' && '✅ Ready'}
                          {emailFile.status === 'error' && '❌ Error'}
                        </div>
                        <button 
                          onClick={() => removeFile(index)}
                          className="btn remove-btn"
                          title="Remove file"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="custom-values-section">
              <h4>Custom Values</h4>
              <div className="custom-values-grid">
                <div className="custom-input">
                  <label>RP Domain:</label>
                  <input
                    type="text"
                    value={customValues.rp}
                    onChange={(e) => handleCustomValueChange('rp', e.target.value)}
                    placeholder="example.com"
                  />
                  <small>Used in: From: info@[RP]</small>
                </div>
                <div className="custom-input">
                  <label>RDNS Domain:</label>
                  <input
                    type="text"
                    value={customValues.rdns}
                    onChange={(e) => handleCustomValueChange('rdns', e.target.value)}
                    placeholder="example.com"
                  />
                  <small>Used in unsubscribe links</small>
                </div>
                <div className="custom-input">
                  <label>AdvUnsub Path:</label>
                  <input
                    type="text"
                    value={customValues.advunsub}
                    onChange={(e) => handleCustomValueChange('advunsub', e.target.value)}
                    placeholder="unsubscribe"
                  />
                  <small>Used in unsubscribe URL path</small>
                </div>
                <div className="custom-input">
                  <label>To Value:</label>
                  <input
                    type="text"
                    value={customValues.to}
                    onChange={(e) => handleCustomValueChange('to', e.target.value)}
                    placeholder="recipient@example.com"
                  />
                  <small>Used in: To: [*To]</small>
                </div>
                <div className="custom-input">
                  <label>Date Value:</label>
                  <input
                    type="text"
                    value={customValues.date}
                    onChange={(e) => handleCustomValueChange('date', e.target.value)}
                    placeholder="Mon, 1 Jan 2024 12:00:00 +0000"
                  />
                  <small>Used in: Date: [*DATE]</small>
                </div>
              </div>
            </div>

            <div className="button-group">
              <button 
                onClick={processAllEmails} 
                className="btn primary"
                disabled={processing || emailFiles.length === 0}
              >
                {processing ? `Processing... (${emailFiles.filter(f => f.status === 'processing').length}/${emailFiles.length})` : `Process All Files (${emailFiles.length})`}
              </button>
              <button onClick={generateSampleEmail} className="btn info">
                Add Sample Email
              </button>
              <button onClick={resetForm} className="btn secondary">
                Reset All
              </button>
            </div>
          </div>
        </div>

        {showResults && (
          <div className="results-section">
            {/* Email Files Overview */}
            <div className="email-files-overview">
              <h3>📊 Processing Results</h3>
              <div className="files-stats">
                <div className="stat-card">
                  <div className="stat-number">{processedEmails.length}</div>
                  <div className="stat-label">Total Files</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">
                    {processedEmails.filter(e => e.status === 'completed').length}
                  </div>
                  <div className="stat-label">Successful</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">
                    {processedEmails.filter(e => e.status === 'error').length}
                  </div>
                  <div className="stat-label">Errors</div>
                </div>
              </div>
              
              {/* Email Navigation */}
              {processedEmails.filter(e => e.status === 'completed').length > 1 && (
                <div className="email-navigation">
                  <h4>Navigate Between Files:</h4>
                  <div className="nav-buttons">
                    {processedEmails.map((email, index) => (
                      email.status === 'completed' && (
                        <button
                          key={index}
                          onClick={() => navigateToEmail(index)}
                          className={`nav-btn ${activeEmailIndex === index ? 'active' : ''}`}
                        >
                          {email.name}
                        </button>
                      )
                    ))}
                  </div>
                </div>
              )}
              
              {processedEmails.filter(e => e.status === 'completed').length > 0 && (
                <div className="bulk-actions">
                  <button onClick={downloadAllEmails} className="btn download-all-btn">
                    📥 Download All Modified Emails
                  </button>
                </div>
              )}
            </div>

            {/* Current Active Email Result */}
            {processedEmails[activeEmailIndex] && (
              <div className="email-result-card">
                <div className="email-header">
                  <h4>{processedEmails[activeEmailIndex].name}</h4>
                  <div className="email-header-actions">
                    <div className={`email-status ${processedEmails[activeEmailIndex].status}`}>
                      {processedEmails[activeEmailIndex].status === 'completed' ? '✅ Processed' : '❌ Error'}
                    </div>
                    {processedEmails[activeEmailIndex].status === 'completed' && (
                      <button 
                        onClick={copyModifiedEmail}
                        className="btn copy-top-btn"
                      >
                        📋 Copy Modified Email
                      </button>
                    )}
                  </div>
                </div>
                
                {processedEmails[activeEmailIndex].status === 'completed' ? (
                  <>
                    <div className="headers-section">
                      <h5>📋 Headers Analysis - {processedEmails[activeEmailIndex].name}</h5>
                      <div className="headers-info">
                        <div className="headers-stats">
                          <span>Total Headers: {processedEmails[activeEmailIndex].headers.length}</span>
                          <span>Kept: {processedEmails[activeEmailIndex].headers.filter(h => !isHeaderRemoved(h) && !isHeaderModified(h) && !isHeaderAdded(h)).length}</span>
                          <span>Removed: {processedEmails[activeEmailIndex].headers.filter(h => isHeaderRemoved(h)).length}</span>
                          <span>Modified: {processedEmails[activeEmailIndex].headers.filter(h => isHeaderModified(h) && !isHeaderRemoved(h)).length}</span>
                          <span>Added: 2</span>
                        </div>
                        <div className="filter-info">
                          <strong>Processing:</strong> Remove headers + Modify From/To/Date/Message-ID + Add Unsubscribe
                        </div>
                      </div>
                      <div className="headers-list">
                        {processedEmails[activeEmailIndex].headers.map((header, index) => {
                          const headerName = header.split(':')[0].trim();
                          const headerValue = header.split(':').slice(1).join(':').trim();
                          const removed = isHeaderRemoved(header);
                          const modified = isHeaderModified(header) && !removed;
                          
                          return (
                            <div key={index} className={`header-item ${removed ? 'removed' : modified ? 'modified' : 'kept'}`}>
                              <div className="header-number">#{index + 1}</div>
                              <div className="header-status">
                                {removed ? '❌' : modified ? '✏️' : '✅'}
                              </div>
                              <div className="header-content">
                                <div className="header-name">{headerName}</div>
                                <div className="header-value">
                                  {headerValue}
                                  {modified && (
                                    <div className="modification-note">
                                      <strong>Modified:</strong> {headerName} field updated
                                    </div>
                                  )}
                                </div>
                                <div className="header-action">
                                  {removed ? 'REMOVED' : modified ? 'MODIFIED' : 'KEPT'}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        {/* Show added headers */}
                        <div className="header-item added">
                          <div className="header-number">+1</div>
                          <div className="header-status">➕</div>
                          <div className="header-content">
                            <div className="header-name">List-Unsubscribe</div>
                            <div className="header-value">
                              {`<mailto:unsubscribe@[${customValues.rdns}]>, <http://[${customValues.rdns}]/[${customValues.advunsub}]>`}
                            </div>
                            <div className="header-action">ADDED</div>
                          </div>
                        </div>
                        <div className="header-item added">
                          <div className="header-number">+2</div>
                          <div className="header-status">➕</div>
                          <div className="header-content">
                            <div className="header-name">List-Unsubscribe-Post</div>
                            <div className="header-value">List-Unsubscribe=One-Click</div>
                            <div className="header-action">ADDED</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="filtered-email-section">
                      <h5>✨ Modified Email - {processedEmails[activeEmailIndex].name}</h5>
                      <div className="email-preview">
                        <textarea
                          value={processedEmails[activeEmailIndex].filteredContent}
                          readOnly
                          rows={15}
                          placeholder="Modified email will appear here..."
                        />
                        <div className="email-actions">
                          <button 
                            onClick={() => navigator.clipboard.writeText(processedEmails[activeEmailIndex].filteredContent)}
                            className="btn copy-btn"
                          >
                            Copy This Email
                          </button>
                          <button 
                            onClick={() => downloadEmail(processedEmails[activeEmailIndex].filteredContent, processedEmails[activeEmailIndex].name)}
                            className="btn download-btn"
                          >
                            Download .eml
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="error-message">
                    <strong>Error processing file:</strong> {processedEmails[activeEmailIndex].error}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
