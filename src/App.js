import React, { useState, useRef, useEffect } from 'react';
import './App.css';

function App() {
  const [emailFiles, setEmailFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [processedEmails, setProcessedEmails] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const [customValues, setCustomValues] = useState({
    rp: 'example.com',
    rdns: 'example.com',
    advunsub: 'unsubscribe',
    to: '*To',
    date: '*DATE',
    fromName: 'Original Sender Name', // NEW
    subject: 'Original Subject' // NEW
  });
  const [activeEmailIndex, setActiveEmailIndex] = useState(0);
  const [viewMode, setViewMode] = useState('headers');
  const [copiedIndex, setCopiedIndex] = useState(null);
  const resultsRef = useRef(null);

  const headersToRemove = [
    'X-MS-Exchange-Transport-CrossTenantHeadersStamped',
    'Content-Type',
    'X-sib-id', 'List-Unsubscribe', 'List-Unsubscribe-Post',
    'X-CSA-Complaints',
    'sender', 'X-Mailin-EID',
    'X-Forwarded-Encrypted',
    'Delivered-To',
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

  const extractHeadersOnly = (content) => {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const headerEndIndex = findHeaderBodySeparator(normalized);
    
    if (headerEndIndex !== -1) {
      return normalized.substring(0, headerEndIndex).trim();
    }
    
    const lines = normalized.split('\n');
    let headerLines = [];
    for (let line of lines) {
      if (line.trim() === '') break;
      headerLines.push(line);
    }
    return headerLines.join('\n');
  };

  const processSingleEmailForHeaders = (emailContent) => {
    try {
      const originalHeaders = extractHeadersOnly(emailContent);
      const headerLines = originalHeaders.split('\n');
      const processedHeaders = [];
      let currentHeader = '';

      headerLines.forEach((line) => {
        if (line.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/)) {
          if (currentHeader) {
            processedHeaders.push(currentHeader);
          }
          currentHeader = line;
        } else if (currentHeader && line.match(/^\s/)) {
          currentHeader += '\n' + line;
        } else if (line.trim() === '') {
          if (currentHeader) {
            processedHeaders.push(currentHeader);
            currentHeader = '';
          }
        }
      });
      
      if (currentHeader) {
        processedHeaders.push(currentHeader);
      }

      let modifiedHeaders = processedHeaders.map(header => {
        const headerName = header.split(':')[0].trim();
        const originalSpacing = header.match(/^[^:]+:\s*/)?.[0] || headerName + ': ';
        
        if (headerName.toLowerCase() === 'message-id') {
          return insertEIDIntoMessageId(header);
        } else if (headerName === 'From') {
          return modifyFromHeader(header, customValues.rp, customValues.fromName);
        } else if (headerName === 'To') {
          return modifyToHeader(header, customValues.to);
        } else if (headerName === 'Date') {
          return modifyDateHeader(header, customValues.date);
        } else if (headerName === 'Subject') {
          return modifySubjectHeader(header, customValues.subject);
        }
        return header;
      });

      modifiedHeaders = modifiedHeaders.filter(header => {
        const headerName = header.split(':')[0].trim();
        
        if (headerName.toLowerCase().startsWith('x-')) {
          return false;
        }
        
        if (headerName === 'Received') {
          const headerValue = header.toLowerCase();
          if (headerValue.includes('received: by') || headerValue.match(/^received:\s*by/i) || headerValue.includes('received: from')) {
            return true;
          }
          return false;
        }
        
        return !headersToRemove.some(toRemove => {
          const cleanToRemove = toRemove.replace(': by', '').toLowerCase();
          return headerName.toLowerCase() === cleanToRemove;
        });
      });

      const unsubscribeHeaders = addUnsubscribeHeaders(customValues.rdns, customValues.advunsub);
      modifiedHeaders.push(...unsubscribeHeaders);

      return {
        headersOnly: modifiedHeaders.join('\n'),
        headerCount: modifiedHeaders.length,
        originalHeaders: originalHeaders
      };

    } catch (error) {
      throw new Error(`Failed to extract headers: ${error.message}`);
    }
  };

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
      status: 'pending',
      originalContent: '',
      filteredContent: '',
      headersOnly: '',
      headerCount: 0,
      originalHeaders: '',
      error: null
    }));
    
    setEmailFiles(prev => [...prev, ...newEmailFiles]);
    event.target.value = '';
  };

  const readFileContent = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e);
      reader.readAsText(file);
    });
  };

  const findHeaderBodySeparator = (content) => {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    const doubleNewline = normalized.indexOf('\n\n');
    if (doubleNewline !== -1) {
      const before = normalized.substring(0, doubleNewline);
      const after = normalized.substring(doubleNewline + 2);
      const firstLineAfter = after.split('\n')[0];
      const looksLikeHeader = firstLineAfter.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/);
      
      if (!looksLikeHeader && after.trim()) {
        return doubleNewline + 2;
      }
    }
    
    const lines = normalized.split('\n');
    let lastHeaderEnd = -1;
    let inHeaders = true;
    let currentHeader = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (inHeaders) {
        if (line.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/)) {
          currentHeader = line;
          lastHeaderEnd = i;
        } else if (currentHeader && line.match(/^\s/)) {
          lastHeaderEnd = i;
        } else if (line.trim() === '') {
          if (lastHeaderEnd !== -1) {
            return lines.slice(0, i + 1).join('\n').length;
          }
        } else {
          inHeaders = false;
          if (lastHeaderEnd !== -1) {
            return lines.slice(0, lastHeaderEnd + 1).join('\n').length;
          }
        }
      }
    }
    
    if (lastHeaderEnd !== -1) {
      return lines.slice(0, lastHeaderEnd + 1).join('\n').length;
    }
    
    return -1;
  };

  const extractFromName = (fromHeader) => {
    if (!fromHeader) return '';
    
    const headerValue = fromHeader.substring(fromHeader.indexOf(':') + 1).trim();
    
    const quotedNameMatch = headerValue.match(/^"([^"]+)"\s*<[^>]+>$/);
    if (quotedNameMatch) return quotedNameMatch[1];
    
    const unquotedNameMatch = headerValue.match(/^([^<]+)\s*<[^>]+>$/);
    if (unquotedNameMatch) return unquotedNameMatch[1].trim();
    
    const emailMatch = headerValue.match(/^<([^>]+)>$/);
    if (emailMatch) {
      const email = emailMatch[1];
      const atIndex = email.indexOf('@');
      if (atIndex !== -1) {
        return email.substring(0, atIndex);
      }
    }
    
    return headerValue;
  };

  const extractOriginalSubject = (subjectHeader) => {
    if (!subjectHeader) return '';
    return subjectHeader.substring(subjectHeader.indexOf(':') + 1).trim();
  };

  const modifyFromHeader = (fromHeader, rpValue, fromNameValue) => {
    if (!fromHeader) return 'From: <info@[' + rpValue + ']>';
    
    let displayName = fromNameValue;
    
    if (fromNameValue === 'Original Sender Name') {
      const originalName = extractFromName(fromHeader);
      displayName = originalName || 'Sender';
    }
    
    const originalSpacing = fromHeader.match(/^From:(\s*)/)?.[1] || ' ';
    
    if (displayName && displayName !== 'Original Sender Name') {
      return `From:${originalSpacing}"${displayName}" <info@[${rpValue}]>`;
    } else {
      return `From:${originalSpacing}<info@[${rpValue}]>`;
    }
  };

  const modifySubjectHeader = (subjectHeader, customSubject) => {
    if (!subjectHeader) return 'Subject: [No Subject]';
    
    const originalSpacing = subjectHeader.match(/^Subject:(\s*)/)?.[1] || ' ';
    
    if (customSubject === 'Original Subject') {
      return subjectHeader;
    } else {
      return `Subject:${originalSpacing}${customSubject}`;
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

    let normalizedContent = emailContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const headerEndIndex = findHeaderBodySeparator(normalizedContent);
    
    if (headerEndIndex === -1) {
      const lines = normalizedContent.split('\n');
      let headerLines = [];
      let bodyLines = [];
      let inHeaders = true;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        if (inHeaders) {
          if (trimmedLine === '') {
            inHeaders = false;
            continue;
          }
          
          if (trimmedLine.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/) || 
              (headerLines.length > 0 && line.match(/^\s/))) {
            headerLines.push(line);
          } else {
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
    const headerLines = headersSection.split('\n');
    const processedHeaders = [];
    let currentHeader = '';

    headerLines.forEach((line) => {
      const originalLine = line;

      if (originalLine.match(/^[A-Za-z][A-Za-z0-9-]*:\s*/)) {
        if (currentHeader) {
          processedHeaders.push(currentHeader);
        }
        currentHeader = originalLine;
      } else if (currentHeader && originalLine.match(/^\s/)) {
        currentHeader += '\n' + originalLine;
      } else if (originalLine.trim() === '') {
        if (currentHeader) {
          processedHeaders.push(currentHeader);
          currentHeader = '';
        }
      } else {
        if (currentHeader) {
          processedHeaders.push(currentHeader);
          currentHeader = '';
        }
      }
    });

    if (currentHeader) {
      processedHeaders.push(currentHeader);
    }

    if (processedHeaders.length === 0) {
      throw new Error('No valid headers found in email');
    }

    let modifiedHeaders = processedHeaders.map(header => {
      const headerName = header.split(':')[0].trim();
      const originalSpacing = header.match(/^[^:]+:\s*/)?.[0] || headerName + ': ';
      
      if (headerName.toLowerCase() === 'message-id') {
        return insertEIDIntoMessageId(header);
      } else if (headerName === 'From') {
        return modifyFromHeader(header, customValues.rp, customValues.fromName);
      } else if (headerName === 'To') {
        return modifyToHeader(header, customValues.to);
      } else if (headerName === 'Date') {
        return modifyDateHeader(header, customValues.date);
      } else if (headerName === 'Subject') {
        return modifySubjectHeader(header, customValues.subject);
      }
      return header;
    });

    modifiedHeaders = modifiedHeaders.filter(header => {
      const headerName = header.split(':')[0].trim();
      
      if (headerName.toLowerCase().startsWith('x-')) {
        return false;
      }
      
      if (headerName === 'Received') {
        const headerValue = header.toLowerCase();
        if (headerValue.includes('received: by') || headerValue.match(/^received:\s*by/i)) {
          return true;
        }
        return false;
      }
      
      return !headersToRemove.some(toRemove => {
        const cleanToRemove = toRemove.replace(': by', '').toLowerCase();
        return headerName.toLowerCase() === cleanToRemove;
      });
    });

    const unsubscribeHeaders = addUnsubscribeHeaders(customValues.rdns, customValues.advunsub);
    modifiedHeaders.push(...unsubscribeHeaders);

    const filteredEmailContent = modifiedHeaders.join('\n') + '\n\n' + bodySection;

    return {
      headers: processedHeaders,
      body: bodySection,
      filteredEmail: filteredEmailContent,
      headersOnly: modifiedHeaders.join('\n'),
      headerCount: modifiedHeaders.length
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
        const headersOnly = processSingleEmailForHeaders(content);
        
        const result = {
          ...emailFile,
          status: 'completed',
          originalContent: content,
          filteredContent: processed.filteredEmail,
          headersOnly: headersOnly.headersOnly,
          headerCount: headersOnly.headerCount,
          originalHeaders: headersOnly.originalHeaders,
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
    setViewMode('headers');
    
    setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  const copyHeadersToClipboard = (index) => {
    if (processedEmails[index] && processedEmails[index].status === 'completed') {
      const headers = processedEmails[index].headersOnly;
      navigator.clipboard.writeText(headers);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    }
  };

  const copyAllHeadersToClipboard = () => {
    const allHeaders = processedEmails
      .filter(e => e.status === 'completed')
      .map(e => `=== ${e.name} ===\n${e.headersOnly}\n\n`)
      .join('');
    
    navigator.clipboard.writeText(allHeaders);
    setCopiedIndex('all');
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const QuickActions = ({ emailIndex }) => {
    const email = processedEmails[emailIndex];
    
    if (!email || email.status !== 'completed') return null;
    
    return (
      <div className="quick-actions">
        <button 
          onClick={() => copyHeadersToClipboard(emailIndex)}
          className={`btn copy-headers-btn ${copiedIndex === emailIndex ? 'copied' : ''}`}
          title="Copy modified headers to clipboard"
        >
          {copiedIndex === emailIndex ? '✅ Copied!' : '📋 Copy Headers'}
        </button>
        
        <button 
          onClick={() => downloadEmail(email.headersOnly, `${email.name.replace('.eml', '')}_headers.txt`)}
          className="btn download-btn"
          title="Download headers as text file"
        >
          ⬇️ Download Headers
        </button>
        
        <button 
          onClick={() => {
            setViewMode('full');
            setActiveEmailIndex(emailIndex);
          }}
          className="btn view-full-btn"
          title="View full modified email"
        >
          📧 View Full Email
        </button>
      </div>
    );
  };

  const downloadEmail = (content, filename) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadAllEmails = () => {
    processedEmails.forEach(email => {
      if (email.status === 'completed') {
        downloadEmail(email.filteredContent, email.name.replace('.eml', '_modified.eml'));
      }
    });
  };

  const resetForm = () => {
    setEmailFiles([]);
    setProcessedEmails([]);
    setShowResults(false);
    setProcessing(false);
    setActiveEmailIndex(0);
    setCopiedIndex(null);
    setCustomValues({
      rp: 'example.com',
      rdns: 'example.com',
      advunsub: 'unsubscribe',
      to: 'recipient@example.com',
      date: new Date().toGMTString(),
      fromName: 'Original Sender Name',
      subject: 'Original Subject'
    });
  };

  const removeFile = (index) => {
    setEmailFiles(prev => prev.filter((_, i) => i !== index));
  };

  const generateSampleEmail = () => {
    const sampleContent = `From: "John Doe" <john@original.com>
To: "Jane Smith" <jane@example.com>
Date: Mon, 15 Jan 2024 10:30:00 +0000
Subject: Meeting Reminder for Tomorrow
Message-ID: <1234567890@mail.original.com>
Content-Type: text/plain; charset="UTF-8"

Dear Jane,

This is a reminder about our meeting tomorrow at 2 PM.

Best regards,
John`;

    const sampleFile = new File([sampleContent], "sample_email.eml", { type: "message/rfc822" });
    
    const newEmailFile = {
      file: sampleFile,
      name: "sample_email.eml",
      size: sampleContent.length,
      status: 'pending',
      originalContent: '',
      filteredContent: '',
      headersOnly: '',
      headerCount: 0,
      originalHeaders: '',
      error: null
    };
    
    setEmailFiles(prev => [...prev, newEmailFile]);
  };

  const navigateToEmail = (index) => {
    setActiveEmailIndex(index);
  };

  useEffect(() => {
    if (showResults) {
      const activeElement = document.querySelector(`.email-result-card.active`);
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [activeEmailIndex, showResults]);

  return (
    <div className="App">
      <header className="App-header">
        <div className="header-brand">
          <div className="company-logo">
            <span className="company-name">EMSL</span>
          </div>
          <div className="header-titles">
            <h1>Email Header Modifier</h1>
            <p className="subtitle">Customize From Name and Subject with one-click copy</p>
          </div>
        </div>
      </header>

      <div className="container">
        <div className="input-section">
          <div className="editor-section">
            <h3>📧 Upload .eml Files</h3>
            
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
                  <div className="upload-icon">📁</div>
                  <div className="upload-text">
                    <strong>Select .eml files</strong>
                    <span>or drag and drop here</span>
                  </div>
                </div>
              </label>
              
              {emailFiles.length > 0 && (
                <div className="file-list">
                  <h4>Selected Files ({emailFiles.length})</h4>
                  {emailFiles.map((emailFile, index) => (
                    <div key={index} className={`file-item ${emailFile.status}`}>
                      <div className="file-info">
                        <div className="file-name">{emailFile.name}</div>
                        <div className="file-size">({(emailFile.size / 1024).toFixed(1)} KB)</div>
                      </div>
                      <div className="file-actions">
                        <div className="file-status">
                          {emailFile.status === 'pending' && '⏳ Ready'}
                          {emailFile.status === 'processing' && '🔄 Processing'}
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
                  <label>From Name:</label>
                  <input
                    type="text"
                    value={customValues.fromName}
                    onChange={(e) => handleCustomValueChange('fromName', e.target.value)}
                    placeholder="Enter custom From Name"
                  />
                  <small>Use "Original Sender Name" to keep original</small>
                </div>
                <div className="custom-input">
                  <label>Subject:</label>
                  <input
                    type="text"
                    value={customValues.subject}
                    onChange={(e) => handleCustomValueChange('subject', e.target.value)}
                    placeholder="Enter custom Subject"
                  />
                  <small>Use "Original Subject" to keep original</small>
                </div>
                <div className="custom-input">
                  <label>RP Domain:</label>
                  <input
                    type="text"
                    value={customValues.rp}
                    onChange={(e) => handleCustomValueChange('rp', e.target.value)}
                    placeholder="example.com"
                  />
                  <small>Used in From email address</small>
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
                  <label>Unsubscribe Path:</label>
                  <input
                    type="text"
                    value={customValues.advunsub}
                    onChange={(e) => handleCustomValueChange('advunsub', e.target.value)}
                    placeholder="unsubscribe"
                  />
                  <small>Path in unsubscribe URL</small>
                </div>
                <div className="custom-input">
                  <label>To Field:</label>
                  <input
                    type="text"
                    value={customValues.to}
                    onChange={(e) => handleCustomValueChange('to', e.target.value)}
                    placeholder="*To"
                  />
                  <small>Custom To field value</small>
                </div>
              </div>
              <div className="custom-values-hint">
                <small>All X-* headers removed. Only "Received: by" headers preserved.</small>
              </div>
            </div>

            <div className="button-group">
              <button 
                onClick={processAllEmails} 
                className="btn primary"
                disabled={processing || emailFiles.length === 0}
              >
                {processing ? '🔄 Processing...' : `⚡ Process ${emailFiles.length} Files`}
              </button>
              <button onClick={generateSampleEmail} className="btn info">
                Add Sample
              </button>
              <button onClick={resetForm} className="btn secondary">
                Reset
              </button>
            </div>
          </div>
        </div>

        {showResults && (
          <div className="results-section" ref={resultsRef}>
            <div className="quick-summary">
              <div className="summary-stats">
                <div className="stat-card">
                  <div className="stat-number">{processedEmails.length}</div>
                  <div className="stat-label">Files</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">
                    {processedEmails.filter(e => e.status === 'completed').length}
                  </div>
                  <div className="stat-label">Successful</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">
                    {processedEmails.reduce((sum, e) => sum + (e.headerCount || 0), 0)}
                  </div>
                  <div className="stat-label">Total Headers</div>
                </div>
              </div>
              
              {processedEmails.filter(e => e.status === 'completed').length > 0 && (
                <div className="bulk-actions">
                  <button 
                    onClick={copyAllHeadersToClipboard} 
                    className={`btn bulk-copy-btn ${copiedIndex === 'all' ? 'copied' : ''}`}
                  >
                    {copiedIndex === 'all' ? '✅ All Headers Copied!' : '📋 Copy All Headers'}
                  </button>
                  <button onClick={downloadAllEmails} className="btn bulk-download-btn">
                    ⬇️ Download All Emails
                  </button>
                  
                  <div className="view-mode-tabs">
                    <button 
                      onClick={() => setViewMode('headers')}
                      className={`view-tab ${viewMode === 'headers' ? 'active' : ''}`}
                    >
                      📋 Headers Only
                    </button>
                    <button 
                      onClick={() => setViewMode('full')}
                      className={`view-tab ${viewMode === 'full' ? 'active' : ''}`}
                    >
                      📧 Full Emails
                    </button>
                    <button 
                      onClick={() => setViewMode('comparison')}
                      className={`view-tab ${viewMode === 'comparison' ? 'active' : ''}`}
                    >
                      ⚖️ Comparison
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="email-results-grid">
              {processedEmails.map((email, index) => (
                <div 
                  key={index} 
                  className={`email-result-card ${activeEmailIndex === index ? 'active' : ''} ${email.status}`}
                  onClick={() => navigateToEmail(index)}
                >
                  <div className="email-card-header">
                    <div className="email-card-title">
                      <h5>{email.name}</h5>
                      <div className="email-status-badge">
                        {email.status === 'completed' ? '✅' : '❌'}
                      </div>
                    </div>
                    {email.status === 'completed' && (
                      <div className="email-card-meta">
                        <span className="meta-item">{email.headerCount || 0} headers</span>
                        <span className="meta-item">{(email.size / 1024).toFixed(1)} KB</span>
                      </div>
                    )}
                  </div>
                  
                  {email.status === 'completed' ? (
                    <>
                      <QuickActions emailIndex={index} />
                      
                      <div className="headers-preview">
                        <div className="preview-header">
                          <h6>Modified Headers Preview:</h6>
                        </div>
                        <div className="headers-content">
                          {email.headersOnly && email.headersOnly.length > 200 
                            ? email.headersOnly.substring(0, 200) + '...' 
                            : email.headersOnly || 'No headers found'}
                        </div>
                      </div>
                      
                      {activeEmailIndex === index && (
                        <div className="detailed-view">
                          {viewMode === 'headers' && (
                            <div className="headers-detailed-view">
                              <textarea
                                value={email.headersOnly}
                                readOnly
                                rows={12}
                                onClick={(e) => e.stopPropagation()}
                                className="headers-textarea"
                              />
                              <div className="view-actions">
                                <button 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyHeadersToClipboard(index);
                                  }}
                                  className={`btn copy-btn ${copiedIndex === index ? 'copied' : ''}`}
                                >
                                  {copiedIndex === index ? '✅ Copied!' : '📋 Copy Headers'}
                                </button>
                              </div>
                            </div>
                          )}
                          
                          {viewMode === 'full' && (
                            <div className="full-email-view">
                              <textarea
                                value={email.filteredContent}
                                readOnly
                                rows={15}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </div>
                          )}
                          
                          {viewMode === 'comparison' && (
                            <div className="comparison-view">
                              <div className="comparison-panel">
                                <h6>Original Headers:</h6>
                                <textarea
                                  value={email.originalHeaders}
                                  readOnly
                                  rows={8}
                                  onClick={(e) => e.stopPropagation()}
                                  className="original-headers"
                                />
                              </div>
                              <div className="comparison-panel">
                                <h6>Modified Headers:</h6>
                                <textarea
                                  value={email.headersOnly}
                                  readOnly
                                  rows={8}
                                  onClick={(e) => e.stopPropagation()}
                                  className="modified-headers"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="error-message">
                      <strong>Error:</strong> {email.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
