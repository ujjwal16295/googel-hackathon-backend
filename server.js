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
const { createClient } = require('@supabase/supabase-js');


require('dotenv').config();
// Initialize Supabase client (add after genAI initialization)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);



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
// Function to calculate risk score based on green, yellow, red points
function calculateRiskScore(greenPoints, yellowPoints, redPoints) {
  const totalPoints = greenPoints + yellowPoints + redPoints;
  
  // Avoid division by zero
  if (totalPoints === 0) {
    return 50; // Neutral score if no points
  }
  
  // Formula: (greenPoints + 0.5 * yellowPoints) / totalPoints
  const numerator = greenPoints + (0.5 * yellowPoints);
  const ratio = numerator / totalPoints;
  
  // Scale to 0-100 (0 = highest risk, 100 = lowest risk)
  const riskScore = Math.round(ratio * 100);
  
  return riskScore;
}
// Replace the analyzeContractWithGemini function in server.js
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
    
    IMPORTANT INSTRUCTIONS FOR RISK ASSESSMENT:
    
    You must categorize ALL clauses, terms, and conditions into THREE risk levels:
    
    1. GREEN (Very Low to No Risk): Favorable, standard, or protective clauses
       - Fair and balanced terms
       - Standard industry practices
       - Clear definitions
       - Reasonable timelines
       - Mutual benefits
       - Adequate protections
       
    2. YELLOW (Medium Risk): Potentially concerning but not critical
       - Slightly vague language
       - Terms that could be more specific
       - Standard risks that need awareness
       - Clauses requiring negotiation consideration
       
    3. RED (High Risk): Critical issues requiring immediate attention
       - Unfair or one-sided terms
       - Unlimited liability
       - Unreasonable obligations
       - Missing protections
       - Ambiguous termination clauses
       - Potentially illegal provisions
    
    CRITICAL: Only include YELLOW and RED risks if they genuinely exist in the contract. Do NOT force-create risks. If the contract is well-written with mostly favorable terms, it's perfectly acceptable to have many GREEN points and few or zero YELLOW/RED points.
    
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
        "keyHighlights": ["array of 5-10 main contract points"],
        "whatIsIncluded": ["array of all key things included in this contract - major clauses, benefits, obligations, deliverables"],
        "contractSummary": "string - 2-3 paragraph comprehensive summary of the entire contract in plain language",
        "wordCount": number,
        "estimatedReadingTime": "string - e.g., '5 minutes'"
      },
      "riskAssessment": {
        "overallRisk": "string - Low/Medium/High (based on the distribution of risk levels)",
        "greenPoints": number - count of favorable/safe clauses,
        "yellowPoints": number - count of moderately risky clauses (ONLY if they exist),
        "redPoints": number - count of high-risk clauses (ONLY if they exist),
        "riskScore": 0,
        "greenRisks": [
          {
            "type": "string - risk category",
            "description": "string - what makes this favorable or low-risk",
            "location": "string - where in document this appears"
          }
        ],
        "yellowRisks": [
          {
            "type": "string - risk category",
            "description": "string - detailed description of the concern",
            "location": "string - where in document this appears",
            "recommendation": "string - suggested action"
          }
        ],
        "redRisks": [
          {
            "type": "string - risk category",
            "description": "string - detailed description of the critical issue",
            "location": "string - where in document this appears",
            "recommendation": "string - urgent action needed"
          }
        ]
      },
      "legalReferences": [
        {
          "reference": "string - the legal reference (e.g., 'Section 48 of Constitution', 'Companies Act 2013', 'IPC Section 420')",
          "context": "string - where/how it's mentioned in contract",
          "shortExplanation": "string - brief plain language explanation of what this law/section means and why it matters in this contract (2-3 sentences)",
          "relevance": "string - High/Medium/Low - how relevant to contract"
        }
      ],
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
        "string - any major concerns that need immediate attention (ONLY if they exist)"
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
    
    Focus on:
    1. Being honest about risk levels - don't inflate or deflate risks
    2. Identifying genuinely favorable clauses as GREEN
    3. Only marking YELLOW if there's a real concern worth noting
    4. Only marking RED if there's a critical issue
    5. Explaining complex legal language in plain terms
    6. Providing actionable recommendations only where needed
    7. Being thorough but realistic about the contract quality
    
    Return only valid JSON without any additional text or formatting.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const analysisText = response.text();
    
    // Clean up the response to ensure it's valid JSON
    const cleanedText = analysisText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    try {
      const analysis = JSON.parse(cleanedText);
      
      // Calculate risk score using the NEW formula
      if (analysis.riskAssessment) {
        const { greenPoints = 0, yellowPoints = 0, redPoints = 0 } = analysis.riskAssessment;
        analysis.riskAssessment.riskScore = calculateRiskScore(greenPoints, yellowPoints, redPoints);
        
        // Ensure the risk arrays exist
        if (!analysis.riskAssessment.greenRisks) analysis.riskAssessment.greenRisks = [];
        if (!analysis.riskAssessment.yellowRisks) analysis.riskAssessment.yellowRisks = [];
        if (!analysis.riskAssessment.redRisks) analysis.riskAssessment.redRisks = [];
      }
      
      // Add metadata
      analysis.metadata = {
        analysisId: uuidv4(),
        timestamp: new Date().toISOString(),
        model: 'gemini-2.5-flash',
        parties: parties
      };
      
      // Ensure other required fields exist (same as before)
      if (!analysis.legalReferences || !Array.isArray(analysis.legalReferences)) {
        analysis.legalReferences = [];
      }
      
      if (analysis.summary) {
        if (!analysis.summary.whatIsIncluded || !Array.isArray(analysis.summary.whatIsIncluded)) {
          analysis.summary.whatIsIncluded = ["Contract details could not be fully extracted"];
        }
        if (!analysis.summary.contractSummary) {
          analysis.summary.contractSummary = "A detailed summary of the contract could not be generated. Please review the document manually.";
        }
      }
      
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
      
      // Fallback response (same as before but with new structure)
      return {
        summary: {
          documentType: "Legal Document",
          mainPurpose: "Contract Analysis",
          keyHighlights: ["Document processed successfully"],
          whatIsIncluded: ["Analysis in progress"],
          contractSummary: "Unable to generate summary due to processing error. Please retry analysis.",
          wordCount: text.split(' ').length,
          estimatedReadingTime: "5 minutes"
        },
        riskAssessment: {
          overallRisk: "Medium",
          greenPoints: 0,
          yellowPoints: 1,
          redPoints: 0,
          riskScore: 50,
          greenRisks: [],
          yellowRisks: [{
            type: "Analysis Error",
            description: "Unable to parse detailed analysis. Please try again or contact support.",
            location: "General",
            recommendation: "Retry analysis or seek manual review"
          }],
          redRisks: []
        },
        legalReferences: [],
        vagueTerms: [],
        keyTerms: [],
        recommendations: ["Please retry the analysis for detailed insights"],
        redFlags: [],
        suggestedQuestions: [
          {
            "question": "What are my main obligations under this contract?",
            "answer": "Due to analysis error, please retry the document analysis for specific obligation details.",
            "category": "Obligations"
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
async function answerQuestionWithGeminiStream(question, analysisContext, conversationHistory = [], originalText = null, res) {
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

    // Use streaming with Gemini
    const result = await model.generateContentStream(prompt);
    
    let fullAnswer = '';
    
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      fullAnswer += chunkText;
      
      // Send chunk to client via SSE
      res.write(`data: ${JSON.stringify({ 
        type: 'chunk', 
        text: chunkText 
      })}\n\n`);
      
      // Flush the response to ensure immediate delivery
      if (res.flush) res.flush();
    }
    
    // Send completion message with metadata
    res.write(`data: ${JSON.stringify({ 
      type: 'done', 
      fullText: fullAnswer,
      metadata: {
        questionId: uuidv4(),
        timestamp: new Date().toISOString(),
        model: 'gemini-2.5-flash'
      }
    })}\n\n`);
    
    if (res.flush) res.flush();
    
  } catch (error) {
    console.error('Error in streaming answer:', error);
    throw error;
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
// Main document analysis endpoint with authentication and serial tracking
app.post('/api/analyze-document', upload.single('document'), async (req, res) => {
  let filePath = null;
  
  try {
    const { parties, email } = req.body; // ADD email parameter
    
    // Check if email is provided
    if (!email) {
      return res.status(400).json({ 
        error: 'Email is required for authentication' 
      });
    }
    
    // Verify email exists in database (authentication check)
    const { data: userData, error: authError } = await supabase
      .from('user_data')
      .select('email, serial')
      .eq('email', email)
      .order('serial', { ascending: false })
      .limit(1);
    
    if (authError) {
      return res.status(500).json({ 
        error: 'Authentication check failed', 
        message: authError.message 
      });
    }
    
    // Get the last serial number for this email (or 0 if no records exist)
    const lastSerial = userData && userData.length > 0 ? userData[0].serial : 0;
    const isAuthenticated = userData && userData.length > 0;
    
    // Optional: Require user to exist in database
    // Uncomment these lines if you want to enforce that user must exist
    /* 
    if (!isAuthenticated) {
      return res.status(401).json({ 
        error: 'Unauthorized', 
        message: 'Email not found in database. Please register first.' 
      });
    } 
    */
    
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
    
    // Return analysis results with authentication and serial info
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
      },
      userInfo: {
        email: email,
        isAuthenticated: isAuthenticated,
        totalRecords: userData && userData.length > 0 ? userData.length : 0
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
app.post('/api/ask-question-stream', async (req, res) => {
  try {
    const { question, analysisId, context, conversationHistory, originalText } = req.body;
    
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
    
    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for Nginx
    
    console.log(`Processing streaming question: ${question}`);
    
    try {
      await answerQuestionWithGeminiStream(
        question, 
        context, 
        conversationHistory || [], 
        originalText || null,
        res
      );
      
      res.end();
    } catch (streamError) {
      console.error('Streaming error:', streamError);
      res.write(`data: ${JSON.stringify({ error: streamError.message })}\n\n`);
      res.end();
    }
    
  } catch (error) {
    console.error('Error processing streaming question:', error);
    
    // If headers not sent yet, send JSON error
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to process question',
        message: error.message
      });
    } else {
      // If streaming already started, send SSE error
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
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

app.post('/api/save-user-data', async (req, res) => {
  try {
    const { email, serial, data } = req.body;
    
    if (!email || serial === undefined || !data) {
      return res.status(400).json({
        error: 'Email, serial, and data are required'
      });
    }

    // Check if record exists
    const { data: existingData, error: fetchError } = await supabase
      .from('user_data')
      .select('*')
      .eq('email', email)
      .eq('serial', serial)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 is "not found" error
      throw fetchError;
    }

    let result;
    if (existingData) {
      // Update existing record
      const { data: updatedData, error: updateError } = await supabase
        .from('user_data')
        .update({ 
          data: data,
          updated_at: new Date().toISOString()
        })
        .eq('email', email)
        .eq('serial', serial)
        .select();

      if (updateError) throw updateError;
      result = updatedData;

      res.json({
        success: true,
        message: 'Data updated successfully',
        data: result[0],
        operation: 'update'
      });

    } else {
      // Insert new record
      const { data: insertedData, error: insertError } = await supabase
        .from('user_data')
        .insert([{ 
          email, 
          serial, 
          data 
        }])
        .select();

      if (insertError) throw insertError;
      result = insertedData;

      res.json({
        success: true,
        message: 'Data saved successfully',
        data: result[0],
        operation: 'insert'
      });
    }

  } catch (error) {
    console.error('Error saving user data:', error);
    
    res.status(500).json({
      error: 'Failed to save data',
      message: error.message
    });
  }
});
app.get('/api/get-user-data/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    if (!email) {
      return res.status(400).json({
        error: 'Email is required'
      });
    }

    const { data, error } = await supabase
      .from('user_data')
      .select('*')
      .eq('email', email)
      .order('serial', { ascending: true });

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        error: 'No data found for this email',
        email: email
      });
    }

    res.json({
      success: true,
      email: email,
      count: data.length,
      data: data
    });

  } catch (error) {
    console.error('Error retrieving user data:', error);
    
    res.status(500).json({
      error: 'Failed to retrieve data',
      message: error.message
    });
  }
});

// Delete specific user data by email and serial
app.delete('/api/delete-user-data/:email/:serial', async (req, res) => {
  try {
    const { email, serial } = req.params;
    
    if (!email || !serial) {
      return res.status(400).json({
        error: 'Email and serial are required'
      });
    }

    // Convert serial to integer
    const serialNumber = parseInt(serial, 10);
    
    if (isNaN(serialNumber)) {
      return res.status(400).json({
        error: 'Serial must be a valid number'
      });
    }

    // Check if record exists before deleting
    const { data: existingData, error: fetchError } = await supabase
      .from('user_data')
      .select('*')
      .eq('email', email)
      .eq('serial', serialNumber)
      .single();

    if (fetchError || !existingData) {
      return res.status(404).json({
        error: 'Record not found',
        message: `No data found for email: ${email} and serial: ${serialNumber}`
      });
    }

    // Delete the record
    const { error: deleteError } = await supabase
      .from('user_data')
      .delete()
      .eq('email', email)
      .eq('serial', serialNumber);

    if (deleteError) throw deleteError;

    res.json({
      success: true,
      message: 'Data deleted successfully',
      deletedRecord: {
        email: email,
        serial: serialNumber
      }
    });

  } catch (error) {
    console.error('Error deleting user data:', error);
    
    res.status(500).json({
      error: 'Failed to delete data',
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