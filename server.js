const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
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
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));


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
async function generateSpeechWithGemini(text, voiceName = 'Puck', stylePrompt = null) {
  try {
    const ttsModel = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash-preview-tts" 
    });

    // Build the prompt with optional style instructions
    const prompt = stylePrompt 
      ? `${stylePrompt}: ${text}` 
      : text;

    const generationConfig = {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName // Options: Puck, Charon, Kore, Fenrir, Aoede
          }
        }
      }
    };

    const result = await ttsModel.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: generationConfig
    });

    const response = await result.response;
    
    // Extract audio data from response
    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    
    if (!audioData) {
      throw new Error('No audio data returned from Gemini TTS');
    }

    return {
      audioData: audioData, // Base64 encoded PCM audio
      mimeType: 'audio/pcm;codec=pcm;rate=24000'
    };

  } catch (error) {
    console.error('Error generating speech with Gemini:', error);
    throw new Error('Failed to generate speech: ' + error.message);
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

For the flowchartData section, create a very simple visual representation of the contract flow including:
1. Contract parties and their roles
2. Key obligations and responsibilities  
3. Payment flow and timelines
4. Termination conditions
5. Decision points and conditional paths
6. Important milestones or deadlines

Position nodes logically with start nodes at top-left and end nodes at bottom-right. Use appropriate node types:
- "start": Contract initiation
- "party": Contract parties
- "process": Actions/obligations  
- "decision": Conditional points
- "end": Contract completion/termination

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
  ],
  "suggestedQuestions": [
    {
      "question": "string - a question users commonly ask about this type of contract",
      "answer": "string - detailed answer based on the contract content",
      "category": "string - e.g., Payment, Termination, Liability, General, Obligations"
    }
  ],
"flowchartData": {
  "nodes": [
    {
      "id": "string - unique identifier",
      "type": "string - start/process/decision/end/party",
      "label": "string - node text",
      "description": "string - detailed explanation",
      "position": {"x": number, "y": number}
    }
  ],
  "edges": [
    {
      "id": "string - unique identifier", 
      "source": "string - source node id",
      "target": "string - target node id",
      "label": "string - edge description",
      "type": "string - default/conditional"
    }
  ],
  "title": "string - flowchart title"
}
}

For the suggestedQuestions section, generate 5 relevant questions that users would commonly ask about this specific contract. Base the questions on:
1. The type of contract and its specific clauses
2. Common concerns people have about similar agreements
3. Important terms that need clarification
4. Potential risks or benefits
5. Practical implications of the contract

Make sure the answers are specific to the actual contract content, not generic responses.

Focus on:
1. Identifying potentially risky or unfavorable clauses
2. Explaining complex legal language in plain terms
3. Highlighting vague or ambiguous terms that could cause disputes
4. Providing actionable recommendations
5. Being thorough but accessible to non-lawyers
6. Generating helpful questions users might have

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
      
      // Ensure suggestedQuestions exists
      if (!analysis.suggestedQuestions || !Array.isArray(analysis.suggestedQuestions)) {
        analysis.suggestedQuestions = [
          {
            "question": "What are my main obligations under this contract?",
            "answer": "Based on the contract analysis, your main obligations would be determined by the specific terms outlined in the agreement. Please refer to the key terms section for detailed obligations.",
            "category": "Obligations"
          },
          {
            "question": "How can this contract be terminated?",
            "answer": "Contract termination procedures should be clearly outlined in the termination clause. Look for specific notice periods and termination conditions.",
            "category": "Termination"
          },
          {
            "question": "What are the payment terms?",
            "answer": "Payment terms including amounts, due dates, and payment methods should be specified in the contract. Check for any late payment penalties.",
            "category": "Payment"
          },
          {
            "question": "What happens if there's a dispute?",
            "answer": "Dispute resolution mechanisms such as mediation, arbitration, or court procedures should be outlined in the contract.",
            "category": "General"
          },
          {
            "question": "What are the potential risks I should be aware of?",
            "answer": "Based on the risk assessment, review the identified risks and red flags in the analysis above.",
            "category": "General"
          }
        ];
      }
      
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
        suggestedQuestions: [
          {
            "question": "What are my main obligations under this contract?",
            "answer": "Due to analysis error, please retry the document analysis for specific obligation details.",
            "category": "Obligations"
          },
          {
            "question": "How can this contract be terminated?",
            "answer": "Termination details could not be analyzed due to processing error. Please retry analysis.",
            "category": "Termination"
          },
          {
            "question": "What are the payment terms?",
            "answer": "Payment information could not be extracted due to analysis error. Please retry.",
            "category": "Payment"
          },
          {
            "question": "What are the potential liability issues?",
            "answer": "Liability assessment failed due to processing error. Please retry the analysis.",
            "category": "Liability"
          },
          {
            "question": "Are there any concerning clauses I should know about?",
            "answer": "Detailed clause analysis failed. Please retry the document analysis for specific concerns.",
            "category": "General"
          }
        ],
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

// Function to answer user questions about the contract
async function answerQuestionWithGemini(question, analysisContext, conversationHistory = [], originalText = null) {
  try {
    // Build conversation context from history
    let conversationContext = '';
    if (conversationHistory && conversationHistory.length > 0) {
      conversationContext = '\n\nPrevious Conversation:\n';
      conversationHistory.forEach(msg => {
        if (msg.role === 'user') {
          conversationContext += `User: ${msg.content}\n`;
        } else if (msg.role === 'assistant') {
          conversationContext += `Assistant: ${msg.content}\n`;
        }
      });
    }

    const prompt = `
You are an expert legal AI assistant. A user has asked a question about their legal document that you've previously analyzed.

${originalText ? `
Full Original Contract Text:
${originalText}

` : ''}
Previous Analysis Context:
${JSON.stringify(analysisContext, null, 2)}
${conversationContext}

Current User Question: "${question}"

Please provide a helpful, accurate answer based on the FULL CONTRACT TEXT and document analysis. Your answer should:
1. Reference specific clauses, sections, or exact text from the contract when relevant
2. Be specific to the actual contract content
3. Reference previous questions/answers if relevant to provide continuity
4. Use plain language that non-lawyers can understand
5. Provide actionable advice when appropriate
6. Be concise but comprehensive
7. If you need to quote the contract, use quotation marks and specify the section/clause if identifiable
8. If the question cannot be answered from the available information, clearly state this

IMPORTANT: Respond with PLAIN TEXT ONLY. Do NOT use:
- Markdown formatting (**, *, ##, etc.)
- Code blocks (\`\`\`)
- HTML tags
- Asterisks or special characters for formatting
- Bullet points with special characters

Just write in clear, natural sentences and paragraphs. Use line breaks for separation if needed.

Respond with just the answer text, no JSON formatting needed.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
    
  } catch (error) {
    console.error('Error getting answer from Gemini:', error);
    throw new Error('Failed to get answer: ' + error.message);
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
      originalText: documentText,
      metadata: {
        source: analysisSource,
        originalFilename: req.file ? req.file.originalname : null,
        processedAt: new Date().toISOString(),
        contentLength: documentText.length,
        model: 'gemini-2.5-flash'
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

// New endpoint for answering user questions
app.post('/api/ask-question', async (req, res) => {
  try {
    const { question, analysisId, context, conversationHistory, originalText } = req.body;  // ADD originalText
    
    if (!question) {
      return res.status(400).json({
        error: 'Question is required'
      });
    }
    
    if (!context) {
      return res.status(400).json({
        error: 'Analysis context is required'
      });
    }
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'AI service not configured',
        message: 'Gemini API key not found'
      });
    }
    
    console.log(`Processing question: ${question}`);
    const answer = await answerQuestionWithGemini(
      question, 
      context, 
      conversationHistory || [], 
      originalText || null  // ADD THIS
    );
    
    res.json({
      success: true,
      answer: answer,
      metadata: {
        questionId: uuidv4(),
        analysisId: analysisId,
        timestamp: new Date().toISOString(),
        model: 'gemini-2.5-flash'
      }
    });
    
  } catch (error) {
    console.error('Error processing question:', error);
    
    res.status(500).json({
      error: 'Failed to process question',
      message: error.message
    });
  }
});
app.post('/api/text-to-speech', async (req, res) => {
  try {
    const { text, voiceName, stylePrompt } = req.body;
    
    if (!text) {
      return res.status(400).json({
        error: 'Text is required'
      });
    }

    // Validate text length (max 900 bytes per Gemini TTS limits)
    if (Buffer.byteLength(text, 'utf8') > 900) {
      return res.status(400).json({
        error: 'Text is too long (maximum 900 bytes)'
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'AI service not configured',
        message: 'Gemini API key not found'
      });
    }

    console.log('Generating speech with Gemini TTS...');
    const result = await generateSpeechWithGemini(
      text, 
      voiceName || 'Puck',
      stylePrompt
    );

    // Return audio data as base64
    res.json({
      success: true,
      audioData: result.audioData,
      mimeType: result.mimeType,
      metadata: {
        voiceName: voiceName || 'Puck',
        model: 'gemini-2.5-flash-preview-tts',
        timestamp: new Date().toISOString(),
        textLength: text.length
      }
    });

  } catch (error) {
    console.error('Error in text-to-speech endpoint:', error);
    
    res.status(500).json({
      error: 'Failed to generate speech',
      message: error.message
    });
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