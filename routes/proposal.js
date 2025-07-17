import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { processCSVForProposal } from '../utils/dataProcessor.js';
import { generateProposal } from '../services/pdfGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../uploads/'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'proposal-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit for CSV/Excel files
  },
  fileFilter: function (req, file, cb) {
    // Accept CSV and Excel files
    const allowedTypes = /csv|xlsx|xls/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype.includes('spreadsheet') || 
                    file.mimetype.includes('csv') ||
                    file.mimetype === 'text/csv' ||
                    file.mimetype === 'application/vnd.ms-excel' ||
                    file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only CSV and Excel files are allowed.'));
    }
  }
});

// POST /api/proposal/generate - Generate proposal from CSV data
router.post('/generate', authenticateToken, requireAdmin, upload.single('csvFile'), async (req, res) => {
  let uploadedFilePath = null;
  
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No CSV file uploaded'
      });
    }

    uploadedFilePath = req.file.path;

    // Get parameters from request body
    const {
      hospitalName,
      contactPerson,
      email,
      title,
      eytherContactEmail,
      eytherContactPhone,
      eytherTeamMember
    } = req.body;

    // Validate required fields
    if (!hospitalName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: hospitalName is required'
      });
    }

    // Log the request for debugging
    console.log('Proposal generation request:', {
      user: req.user.email,
      file: req.file.filename,
      hospitalName,
      contactPerson,
      email,
      title
    });

    // Process CSV file
    const processedData = await processCSVForProposal(uploadedFilePath, {
      hospitalName,
      contactPerson,
      email,
      title,
      eytherContactEmail,
      eytherContactPhone,
      eytherTeamMember
    });

    if (!processedData.success) {
      throw new Error(processedData.error || 'Failed to process CSV data');
    }

    // Generate PDF filename
    const sanitizedHospitalName = hospitalName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const timestamp = Date.now();
    const pdfFileName = `proposal_${sanitizedHospitalName}_${timestamp}.pdf`;

    // Generate PDF
    const pdfResult = await generateProposal(processedData, pdfFileName);

    if (!pdfResult.success) {
      throw new Error(pdfResult.error || 'Failed to generate PDF');
    }

    // Read the generated PDF
    const pdfBuffer = await fs.readFile(pdfResult.path);
    
    // Clean up uploaded CSV file
    await fs.unlink(uploadedFilePath);
    uploadedFilePath = null;

    // Send PDF as response
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${pdfFileName}"`,
      'Content-Length': pdfBuffer.length
    });

    res.send(pdfBuffer);

    // Clean up generated PDF after sending
    setTimeout(async () => {
      try {
        await fs.unlink(pdfResult.path);
      } catch (err) {
        console.error('Error cleaning up PDF:', err);
      }
    }, 5000);

  } catch (error) {
    console.error('Proposal generation error:', error);
    
    // Clean up uploaded file if it exists
    if (uploadedFilePath) {
      try {
        await fs.unlink(uploadedFilePath);
      } catch (cleanupError) {
        console.error('Error cleaning up uploaded file:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Error generating proposal',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Error handling middleware for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false,
        message: 'File size too large. Maximum size is 50MB.' 
      });
    }
    return res.status(400).json({ 
      success: false,
      message: error.message 
    });
  } else if (error) {
    return res.status(400).json({ 
      success: false,
      message: error.message 
    });
  }
  next();
});

export default router;