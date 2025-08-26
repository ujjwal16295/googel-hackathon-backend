const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();


const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs for AI processing
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});
app.use('/api/', limiter);

// Temporary storage setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueId = uuidv4();
    const extension = path.extname(file.originalname);
    cb(null, `${uniqueId}${extension}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.doc', '.docx', '.txt'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed.'));
    }
  }
});

// Utility function to extract text from different file types
async function extractTextFromFile(filePath, originalName) {
  const extension = path.extname(originalName).toLowerCase();
  
  try {
    switch (extension) {
      case '.pdf':
        const pdfBuffer = fs.readFileSync(filePath);
        const pdfData = await pdf(pdfBuffer);
        return pdfData.text;
        
      case '.doc':
      case '.docx':
        const docBuffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer: docBuffer });
        return result.value;
        
      case '.txt':
        return fs.readFileSync(filePath, 'utf8');
        
      default:
        throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Error extracting text from file:', error);
    throw new Error('Failed to extract text from document');
  }
}

// Gemini AI analysis function
async function analyzeContractWithGemini(text, parties = {}) {
  try {
    const prompt = `
You are an expert legal AI assistant specializing in contract analysis. Please analyze the following legal document and provide a comprehensive assessment in JSON format.

Contract Text:
${text}

${parties.party1 || parties.party2 ? `
Parties involved:
- Party 1: ${parties.party1 || 'Not specified'}
- Party 2: ${parties.party2 || 'Not specified'}
` : ''}

Please provide your analysis in the following JSON structure:

{
  "summary": {
    "documentType": "string - type of contract (e.g., Service Agreement, Employment Contract, etc.)",
    "mainPurpose": "string - primary purpose of the contract",
    "keyHighlights": ["array of 3-5 main contract points"],
    "wordCount": number,
    "estimatedReadingTime": "string - e.g., '5 minutes'"
  },
  "riskAssessment": {
    "overallRisk": "string - Low/Medium/High",
    "riskScore": number (1-10),
    "risks": [
      {
        "type": "string - risk category",
        "severity": "string - Low/Medium/High",
        "description": "string - detailed description",
        "location": "string - where in document this appears",
        "recommendation": "string - suggested action"
      }
    ]
  },
  "vagueTerms": [
    {
      "term": "string - the vague term found",
      "context": "string - surrounding context",
      "issue": "string - why this is problematic",
      "suggestion": "string - how to clarify"
    }
  ],
  "keyTerms": [
    {
      "category": "string - e.g., Payment, Termination, Liability",
      "term": "string - the actual term",
      "explanation": "string - plain language explanation",
      "importance": "string - High/Medium/Low"
    }
  ],
  "recommendations": [
    "string - actionable recommendations for the user"
  ],
  "redFlags": [
    "string - any major concerns that need immediate attention"
  ]
}

Focus on:
1. Identifying potentially risky or unfavorable clauses
2. Explaining complex legal language in plain terms
3. Highlighting vague or ambiguous terms that could cause disputes
4. Providing actionable recommendations
5. Being thorough but accessible to non-lawyers

Return only valid JSON without any additional text or formatting.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const analysisText = response.text();
    
    // Clean up the response to ensure it's valid JSON
    const cleanedText = analysisText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    try {
      const analysis = JSON.parse(cleanedText);
      
      // Add metadata
      analysis.metadata = {
        analysisId: uuidv4(),
        timestamp: new Date().toISOString(),
        model: 'gemini-2.5-flash',
        parties: parties
      };
      
      return analysis;
      
    } catch (parseError) {
      console.error('Error parsing Gemini response as JSON:', parseError);
      console.log('Raw response:', analysisText);
      
      // Fallback response if JSON parsing fails
      return {
        summary: {
          documentType: "Legal Document",
          mainPurpose: "Contract Analysis",
          keyHighlights: ["Document processed successfully"],
          wordCount: text.split(' ').length,
          estimatedReadingTime: "5 minutes"
        },
        riskAssessment: {
          overallRisk: "Medium",
          riskScore: 5,
          risks: [{
            type: "Analysis Error",
            severity: "Medium",
            description: "Unable to parse detailed analysis. Please try again or contact support.",
            location: "General",
            recommendation: "Retry analysis or seek manual review"
          }]
        },
        vagueTerms: [],
        keyTerms: [],
        recommendations: ["Please retry the analysis for detailed insights"],
        redFlags: [],
        metadata: {
          analysisId: uuidv4(),
          timestamp: new Date().toISOString(),
          model: 'gemini-2.5-flash',
          parties: parties,
          error: 'JSON parsing failed'
        }
      };
    }
    
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    throw new Error('Failed to analyze document with AI: ' + error.message);
  }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Legal AI Backend is running',
    timestamp: new Date().toISOString(),
    geminiConfigured: !!process.env.GEMINI_API_KEY
  });
});

// Main document analysis endpoint
app.post('/api/analyze-document', upload.single('document'), async (req, res) => {
  let filePath = null;
  
  try {
    const { parties } = req.body;
    let documentText = '';
    let analysisSource = '';
    
    if (req.file) {
      // File upload processing
      filePath = req.file.path;
      analysisSource = 'file';
      
      console.log(`Processing file: ${req.file.originalname}`);
      documentText = await extractTextFromFile(filePath, req.file.originalname);
      
    } else if (req.body.text) {
      // Direct text input processing
      documentText = req.body.text;
      analysisSource = 'text';
      console.log('Processing direct text input');
      
    } else {
      return res.status(400).json({
        error: 'No document or text provided'
      });
    }
    
    // Validate minimum content length
    if (documentText.length < 100) {
      return res.status(400).json({
        error: 'Document content is too short for meaningful analysis (minimum 100 characters)'
      });
    }
    
    // Validate maximum content length for Gemini
    if (documentText.length > 100000) {
      return res.status(400).json({
        error: 'Document content is too long (maximum 100,000 characters)'
      });
    }
    
    // Parse parties if provided
    let parsedParties = {};
    if (parties) {
      try {
        parsedParties = typeof parties === 'string' ? JSON.parse(parties) : parties;
      } catch (e) {
        console.warn('Failed to parse parties data:', e);
      }
    }
    
    // Check if Gemini API key is configured
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'AI service not configured',
        message: 'Gemini API key not found'
      });
    }
    
    // Perform AI analysis with Gemini
    console.log('Starting Gemini AI analysis...');
    const analysis = await analyzeContractWithGemini(documentText, parsedParties);
    
    console.log('Gemini analysis completed successfully');
    
    // Return analysis results
    res.json({
      success: true,
      analysis: analysis,
      metadata: {
        source: analysisSource,
        originalFilename: req.file ? req.file.originalname : null,
        processedAt: new Date().toISOString(),
        contentLength: documentText.length,
        model: 'gemini-2.0-flash-exp'
      }
    });
    
  } catch (error) {
    console.error('Error processing document:', error);
    
    res.status(500).json({
      error: 'Failed to process document',
      message: error.message,
      details: error.stack
    });
    
  } finally {
    // Always clean up temporary file
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Temporary file deleted: ${filePath}`);
      } catch (deleteError) {
        console.error('Error deleting temporary file:', deleteError);
      }
    }
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'File size must be less than 10MB'
      });
    }
  }
  
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
// app.use('*', (req, res) => {
//   res.status(404).json({
//     error: 'Endpoint not found'
//   });
// });

// Cleanup function for temporary files
function cleanupTempFiles() {
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      try {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up: ${file}`);
      } catch (error) {
        console.error(`Error cleaning up ${file}:`, error);
      }
    });
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Server shutting down...');
  cleanupTempFiles();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Server terminated...');
  cleanupTempFiles();
  process.exit(0);
});

// Periodic cleanup of old temp files (every hour)
setInterval(() => {
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      try {
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtime.getTime();
        
        // Delete files older than 1 hour
        if (fileAge > 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          console.log(`Auto-cleaned old temp file: ${file}`);
        }
      } catch (error) {
        console.error(`Error processing temp file ${file}:`, error);
      }
    });
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Legal AI Backend Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Gemini API configured: ${!!process.env.GEMINI_API_KEY}`);
});

module.exports = app;