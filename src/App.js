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
  const [viewMode, setViewMode] = useState('comparison'); // 'comparison', 'modified', 'original'

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

  // Improved header-body separator that preserves UTF-8
  const findHeaderBodySeparator = (content) => {
    // Normalize line endings but preserve other characters
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Method 1: Look for double newline (standard RFC 5322)
    const doubleNewline = normalized.indexOf('\n\n');
    if (doubleNewline !== -1) {
      // Verify this is a true header-body separator
      const before = normalized.substring(0, doubleNewline);
      const after = normalized.substring(doubleNewline + 2);
      
      // Check if the part after looks like headers or body
      const firstLineAfter = after.split('\n')[0];
      const looksLikeHeader = firstLineAfter.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/);
      
      if (!looksLikeHeader && after.trim()) {
        return doubleNewline + 2;
      }
    }
    
    // Method 2: More robust parsing
    const lines = normalized.split('\n');
    let lastHeaderEnd = -1;
    let inHeaders = true;
    let currentHeader = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (inHeaders) {
        // Check if this is a new header line
        if (line.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/)) {
          currentHeader = line;
          lastHeaderEnd = i;
        } 
        // Check if this is a continuation line
        else if (currentHeader && line.match(/^\s/)) {
          lastHeaderEnd = i;
        }
        // Empty line that ends headers
        else if (line.trim() === '') {
          if (lastHeaderEnd !== -1) {
            return lines.slice(0, i + 1).join('\n').length;
          }
        }
        // Non-header, non-continuation, non-empty line - probably body
        else {
          inHeaders = false;
          if (lastHeaderEnd !== -1) {
            return lines.slice(0, lastHeaderEnd + 1).join('\n').length;
          }
        }
      }
    }
    
    // Fallback: if we found headers but no clear separator, use last header
    if (lastHeaderEnd !== -1) {
      return lines.slice(0, lastHeaderEnd + 1).join('\n').length;
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

  // Fixed helper functions to preserve formatting
  const modifyFromHeader = (fromHeader, rpValue) => {
    if (!fromHeader) return 'From: <info@[' + rpValue + ']>';
    
    const fromName = extractFromName(fromHeader);
    // Preserve the original spacing after "From:"
    const originalSpacing = fromHeader.match(/^From:(\s*)/)?.[1] || ' ';
    
    if (fromName) {
      return `From:${originalSpacing}"${fromName}" <info@[${rpValue}]>`;
    } else {
      return `From:${originalSpacing}<info@[${rpValue}]>`;
    }
  };

  const insertEIDIntoMessageId = (messageId) => {
    if (!messageId) return messageId;
    
    const messageIdMatch = messageId.match(/^Message-ID:\s*(<[^>]+>)/i);
    if (!messageIdMatch) return messageId;
    
    const fullMessageId = messageIdMatch[0];
    const messageIdValue = messageIdMatch[1];
    const originalSpacing = messageId.match(/^Message-ID:(\s*)/)?.[1] || ' ';
    
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
    
    return `Message-ID:${originalSpacing}<${modifiedContent}>`;
  };

  const addUnsubscribeHeaders = (rdnsValue, advunsubValue) => {
    return [
      `List-Unsubscribe: <mailto:unsubscribe@[${rdnsValue}]>, <http://[${rdnsValue}]/[${advunsubValue}]>`,
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
    ];
  };

  const modifyToHeader = (toHeader, toValue) => {
    const originalSpacing = toHeader.match(/^To:(\s*)/)?.[1] || ' ';
    return `To:${originalSpacing}[${toValue}]`;
  };

  const modifyDateHeader = (dateHeader, dateValue) => {
    const originalSpacing = dateHeader.match(/^Date:(\s*)/)?.[1] || ' ';
    return `Date:${originalSpacing}[${dateValue}]`;
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

    // Process headers with proper multi-line handling and spacing preservation
    const headerLines = headersSection.split('\n');
    const processedHeaders = [];
    let currentHeader = '';

    headerLines.forEach((line, index) => {
      // Preserve the exact line including whitespace
      const originalLine = line;

      // Check if this line starts a new header (starts with header name followed by colon)
      if (originalLine.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/)) {
        // If we have a current header being built, push it before starting new one
        if (currentHeader) {
          processedHeaders.push(currentHeader);
        }
        currentHeader = originalLine;
      } 
      // Check if this is a continuation line (starts with whitespace)
      else if (currentHeader && originalLine.match(/^\s/)) {
        // Continue the current header with proper line break and spacing
        currentHeader += '\n' + originalLine;
      }
      // Handle empty lines (shouldn't occur in headers section, but if they do)
      else if (originalLine.trim() === '') {
        if (currentHeader) {
          processedHeaders.push(currentHeader);
          currentHeader = '';
        }
      }
      // If we encounter a non-header line that's not a continuation
      else {
        // This might be malformed content
        if (currentHeader) {
          processedHeaders.push(currentHeader);
          currentHeader = '';
        }
        // Optionally preserve malformed lines or skip them
        // processedHeaders.push(originalLine);
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

    // Apply modifications with proper spacing preservation
    let modifiedHeaders = processedHeaders.map(header => {
      const headerName = header.split(':')[0].trim();
      const originalSpacing = header.match(/^[^:]+:\s*/)?.[0] || headerName + ': ';
      
      if (headerName === 'Message-ID') {
        return insertEIDIntoMessageId(header);
      } else if (headerName === 'From') {
        return modifyFromHeader(header, customValues.rp);
      } else if (headerName === 'To') {
        return modifyToHeader(header, customValues.to);
      } else if (headerName === 'Date') {
        return modifyDateHeader(header, customValues.date);
      }
      return header; // Return original header with preserved formatting
    });

    // Remove specified headers including ALL X- headers
    modifiedHeaders = modifiedHeaders.filter(header => {
      const headerName = header.split(':')[0].trim();
      
      // Remove ALL headers starting with X- (case insensitive)
      if (headerName.toLowerCase().startsWith('x-')) {
        return false;
      }
      
      if (headerName === 'Received') {
        const headerValue = header.toLowerCase();
        // Only remove "Received: by" headers, keep "Received: from"
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

    // Add unsubscribe headers with proper formatting
    const unsubscribeHeaders = addUnsubscribeHeaders(customValues.rdns, customValues.advunsub);
    modifiedHeaders.push(...unsubscribeHeaders);

    // Preserve the exact spacing between headers and body
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
X-Custom-Header: This should be removed too
X-Another-Header: Another X- header to remove
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
                      <div className="view-mode-selector">
                        <button 
                          onClick={() => setViewMode('comparison')}
                          className={`btn view-btn ${viewMode === 'comparison' ? 'active' : ''}`}
                        >
                          📊 Comparison
                        </button>
                        <button 
                          onClick={() => setViewMode('modified')}
                          className={`btn view-btn ${viewMode === 'modified' ? 'active' : ''}`}
                        >
                          ✨ Modified Only
                        </button>
                        <button 
                          onClick={() => setViewMode('original')}
                          className={`btn view-btn ${viewMode === 'original' ? 'active' : ''}`}
                        >
                          📝 Original Only
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                
                {processedEmails[activeEmailIndex].status === 'completed' ? (
                  <>
                    <div className="headers-section">
                      <h5>📋 Processing Summary - {processedEmails[activeEmailIndex].name}</h5>
                      <div className="headers-info">
                        <div className="filter-info">
                          <strong>Processing Applied:</strong> Remove ALL X-* headers + Remove specific headers + Modify From/To/Date/Message-ID + Add Unsubscribe
                        </div>
                      </div>
                    </div>

                    <div className="filtered-email-section">
                      <div className="email-preview-header">
                        <h5>
                          {viewMode === 'comparison' && '📊 Original vs Modified Email'}
                          {viewMode === 'modified' && '✨ Modified Email'}
                          {viewMode === 'original' && '📝 Original Email'}
                        </h5>
                        <div className="email-actions">
                          {viewMode === 'modified' && (
                            <>
                              <button 
                                onClick={() => navigator.clipboard.writeText(processedEmails[activeEmailIndex].filteredContent)}
                                className="btn copy-btn"
                              >
                                Copy Modified Email
                              </button>
                              <button 
                                onClick={() => downloadEmail(processedEmails[activeEmailIndex].filteredContent, processedEmails[activeEmailIndex].name)}
                                className="btn download-btn"
                              >
                                Download .eml
                              </button>
                            </>
                          )}
                          {viewMode === 'original' && (
                            <button 
                              onClick={() => navigator.clipboard.writeText(processedEmails[activeEmailIndex].originalContent)}
                              className="btn copy-btn"
                            >
                              Copy Original Email
                            </button>
                          )}
                          {viewMode === 'comparison' && (
                            <button 
                              onClick={copyModifiedEmail}
                              className="btn copy-top-btn"
                            >
                              📋 Copy Modified Email
                            </button>
                          )}
                        </div>
                      </div>
                      
                      <div className="email-preview-container">
                        {viewMode === 'comparison' && (
                          <div className="comparison-view">
                            <div className="comparison-panel">
                              <div className="panel-header original-header">
                                <h6>📝 Original Email</h6>
                              </div>
                              <textarea
                                value={processedEmails[activeEmailIndex].originalContent}
                                readOnly
                                rows={15}
                                placeholder="Original email content..."
                                className="original-email"
                              />
                            </div>
                            <div className="comparison-panel">
                              <div className="panel-header modified-header">
                                <h6>✨ Modified Email</h6>
                              </div>
                              <textarea
                                value={processedEmails[activeEmailIndex].filteredContent}
                                readOnly
                                rows={15}
                                placeholder="Modified email content..."
                                className="modified-email"
                              />
                            </div>
                          </div>
                        )}
                        
                        {viewMode === 'modified' && (
                          <div className="single-view">
                            <textarea
                              value={processedEmails[activeEmailIndex].filteredContent}
                              readOnly
                              rows={20}
                              placeholder="Modified email will appear here..."
                            />
                          </div>
                        )}
                        
                        {viewMode === 'original' && (
                          <div className="single-view">
                            <textarea
                              value={processedEmails[activeEmailIndex].originalContent}
                              readOnly
                              rows={20}
                              placeholder="Original email content..."
                            />
                          </div>
                        )}
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
