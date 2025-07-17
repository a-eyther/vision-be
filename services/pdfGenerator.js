import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Browser instance for reuse (better performance)
let browserInstance = null;

// Get or create browser instance
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });
  }
  return browserInstance;
}

// Close browser instance (for cleanup)
export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// Replace placeholders in template
function replacePlaceholders(template, data) {
  let result = template;
  
  // Handle conditional sections first (more complex)
  result = result.replace(/{{#if\s+(\w+)}}([\s\S]*?){{\/if}}/g, (match, condition, content) => {
    // Check boolean conditions or non-empty values
    const shouldShow = typeof data[condition] === 'boolean' 
      ? data[condition] 
      : (data[condition] && data[condition] !== '');
    return shouldShow ? content : '';
  });
  
  // Handle negative conditions {{#unless condition}}
  result = result.replace(/{{#unless\s+(\w+)}}([\s\S]*?){{\/unless}}/g, (match, condition, content) => {
    const shouldHide = typeof data[condition] === 'boolean' 
      ? data[condition] 
      : (data[condition] && data[condition] !== '');
    return !shouldHide ? content : '';
  });
  
  // Replace simple placeholders
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(placeholder, value || '');
  }
  
  // Clean up any remaining template syntax
  result = result.replace(/{{[^}]*}}/g, '');
  
  return result;
}

// Generate PDF from HTML template and data
export async function generateProposalPDF(templateData, outputPath) {
  let browser = null;
  let page = null;
  
  try {
    // Get browser instance
    browser = await getBrowser();
    page = await browser.newPage();
    
    // Read HTML template
    const templatePath = path.join(__dirname, '../templates/proposal_template.html');
    const template = await fs.readFile(templatePath, 'utf-8');
    
    // Replace placeholders with actual data
    const filledHTML = replacePlaceholders(template, templateData);
    
    // Set viewport for consistent rendering
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set content with proper base URL for relative paths
    await page.setContent(filledHTML, { 
      waitUntil: 'networkidle0',
      timeout: 30000 
    });
    
    // Add cache-busting and ensure content is fully loaded
    await page.addStyleTag({
      content: `
        * { print-color-adjust: exact !important; }
        .page-break { page-break-before: always !important; }
        h2, h3 { page-break-after: avoid !important; }
        table { page-break-inside: avoid !important; }
      `
    });
    
    // Wait a bit for any animations or fonts to load
    await page.evaluateHandle('document.fonts.ready');
    
    // Additional wait to ensure all content is rendered
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Generate PDF with specific settings
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: false,
      margin: {
        top: '0.5in',
        right: '0.5in',
        bottom: '0.5in',
        left: '0.5in'
      },
      preferCSSPageSize: true
    });
    
    // Verify PDF was created
    const stats = await fs.stat(outputPath);
    if (stats.size === 0) {
      throw new Error('Generated PDF is empty');
    }
    
    return {
      success: true,
      path: outputPath,
      size: stats.size
    };
    
  } catch (error) {
    console.error('PDF generation error:', error);
    throw new Error(`Failed to generate PDF: ${error.message}`);
  } finally {
    // Close the page but keep browser instance
    if (page) {
      await page.close();
    }
  }
}

// Generate proposal with complete flow
export async function generateProposal(processedData, outputFileName) {
  try {
    // Ensure output directory exists
    const outputDir = path.join(__dirname, '../generated');
    await fs.mkdir(outputDir, { recursive: true });
    
    // Generate output path
    const outputPath = path.join(outputDir, outputFileName);
    
    // Generate PDF
    const result = await generateProposalPDF(processedData.templateData, outputPath);
    
    return {
      success: true,
      ...result,
      fileName: outputFileName
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Cleanup function for graceful shutdown
export async function cleanup() {
  await closeBrowser();
}

// Handle process termination
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

export default {
  generateProposalPDF,
  generateProposal,
  closeBrowser,
  cleanup
};