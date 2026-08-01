import { google } from 'googleapis';
import OpenAI from 'openai';
import readline from 'readline';
import path from "path";
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import {
  CHOICE_GRAPH_MARKER, CHOICE_IMAGE_LABEL,
  RW_QUESTION_COUNT, MATH_QUESTION_COUNT,
  FIRST_MATH_ROW, LAST_QUESTION_ROW, QUESTION_CAPACITY,
  sectionFor, pageIsMath, pageNumberFromImage, questionHasChoiceGraphs,
  parseQuestion, cleanJsonResponse, unwrapQuestions, parseTranscriptionResponse,
  mapWithConcurrency, reportRunHealth, planPageWrite, mergePageContinuations,
  normaliseAnswer, salvageQuestionFields,
} from './lib/pipeline.js';

import express, { response } from 'express';
import cors from 'cors';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the path resolved by Electron (APP_ENV_PATH) when launched by the
// app, or from the local directory when run standalone (e.g. `npm run server`).
dotenv.config({ path: process.env.APP_ENV_PATH || path.join(__dirname, '.env') });

// Resolve a config/credential file from the writable app-data dir (where the
// preflight screen saves user-added files) first, then the local directory.
function resolveConfigFile(name) {
  for (const dir of [process.env.APP_DATA_DIR, __dirname].filter(Boolean)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, name);
}

const app = express();
app.use(cors()); // Enables CORS for all origins
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true}));

const range = 'Question!A1';

// OpenAI API setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets API setup
const SERVICE_ACCOUNT_FILE = resolveConfigFile('sheets_credentials.json'); // Path to your service account key file
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // Replace with your spreadsheet ID

const EXPORT_FOLDER_ID = process.env.EXPORT_FOLDER_ID;

// Authenticate with Google Sheets
const auth = new google.auth.GoogleAuth({   
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const DRIVE_CREDENTIALS_PATH = resolveConfigFile('drive_credentials.json');
const DRIVE_TOKEN_PATH = resolveConfigFile('drive_token.json');
// Refreshed tokens are written to a writable location (app-data when packaged,
// since the bundled copy may be read-only).
const DRIVE_TOKEN_WRITE_PATH = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, 'drive_token.json')
  : DRIVE_TOKEN_PATH;

function getDriveOAuth2Client() {
  if (!fs.existsSync(DRIVE_TOKEN_PATH)) {
    throw new Error('Drive not authorized. Run: node auth_drive.js first.');
  }
  const creds = JSON.parse(fs.readFileSync(DRIVE_CREDENTIALS_PATH));
  const { client_id, client_secret } = creds.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:4000');
  const token = JSON.parse(fs.readFileSync(DRIVE_TOKEN_PATH));
  oauth2Client.setCredentials(token);
  // Auto-save refreshed tokens
  oauth2Client.on('tokens', (tokens) => {
    try {
      const existing = JSON.parse(fs.readFileSync(DRIVE_TOKEN_PATH));
      fs.writeFileSync(DRIVE_TOKEN_WRITE_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
      console.log('🔄 Drive token refreshed and saved.');
    } catch (err) {
      console.error('⚠️ Could not save refreshed Drive token:', err.message);
    }
  });
  return oauth2Client;
}

const drive = google.drive({ version: 'v3', auth: getDriveOAuth2Client() });

const FOLDER_ID = process.env.FOLDER_ID;
const FOLDER_PDF = process.env.FOLDER_PDF;

// Define a persistent output directory. Prefer the app-data dir Electron passes
// (guaranteed writable, cross-platform); fall back to the OS home/appdata.
const isPackaged = process.env.ELECTRON_IS_PACKAGED === 'true';
const OUTPUT_DIR = isPackaged
  ? path.join(
      process.env.APP_DATA_DIR || path.join(process.env.APPDATA || process.env.HOME || __dirname, "pdf-transcriber"),
      "converted_images"
    )
  : path.resolve("converted_images");

// Create output directory if it doesn't exist
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`✅ Created output directory at: ${OUTPUT_DIR}`);
}

// Clear converted_images folder on startup
function clearConvertedImagesFolder() {
  console.log("🧹 Cleaning up converted_images folder on startup...");
  try {
    if (fs.existsSync(OUTPUT_DIR)) {
      // withFileTypes so subfolders (page thumbnails) are removed as folders;
      // unlinkSync fails with EPERM on a directory.
      for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
        const target = path.join(OUTPUT_DIR, entry.name);
        if (entry.isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
        }
        console.log(`✅ Deleted: ${entry.name}`);
      }
      console.log("✨ Converted images folder cleaned successfully");
    } else {
      console.log("📂 No converted_images folder found, creating one...");
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
  } catch (error) {
    console.error("❌ Error cleaning converted_images folder:", error);
  }
}

// Add this right before the app.listen call
clearConvertedImagesFolder();

async function listFilesInFolder(folderId) {
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and (mimeType contains 'image/' or mimeType = 'application/pdf') and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (!response.data || !response.data.files) {
      throw new Error('No data returned from Google Drive API.');
    }

    let files = response.data.files;

    if (files.length === 0) {
      console.log('No files found in the folder.');
      return [];
    }

    function getQuestionNumber(filename) {
      const match = filename.match(/Q(\d+)/i);
      return match ? parseInt(match[1], 10) : 0;
    }

    files.sort((a, b) => {
      try {
        const numA = getQuestionNumber(a.name);
        const numB = getQuestionNumber(b.name);
        return numA - numB;
      } catch (error) {
        console.log(`Warning: Error sorting files ${a.name} and ${b.name}:`, error);
        return 0;
      }
    });

    console.log('Files in folder (sorted by question number):');
    files.forEach(file => {
      console.log(`- ${file.name} (ID: ${file.id})`);
    });

    return files;
  } catch (error) {
    console.error('Error listing files in folder:', error);
    throw error;
  }
}

// Call the function
// listFilesInFolder(FOLDER_ID);

async function fetchImageFromGoogleDrive(fileId) {
  try {
    const response = await drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      { responseType: 'arraybuffer' }
    );

    const imageBuffer = Buffer.from(response.data, 'binary'); // Convert binary data to a Buffer
    return imageBuffer.toString('base64'); // Convert the Buffer to a Base64 string
  } catch (error) {
    console.error('Error fetching file from Google Drive:', error.message);
    throw error; // Re-throw the error so it can be caught elsewhere
  }
}

let lastResponse = [];
app.post('/chat', async (req, res) => {

  try {

    const { prompt } = req.body; // Get user input (prompt) from the request body
    console.log('Extracted prompt:', prompt);

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Always respond in valid JSON format with no extra text or explanations. You are a helpful assistant that can create text-based Reading and Writing Exams. 

If I provide you with a passage and/or a question, generate a question of the same difficulty that assesses the same skill (e.g., if the original question tests vocabulary, your question should also test vocabulary). 

The question and options can include bold, italics, and underlines using the following formatting:
- Bold: **text** (use double asterisks)
- Italics: *text* (use single asterisks)
- Underline: {text} (use curly braces)

Use \\n\\n for double line breaks and \\n for single line breaks. The output must strictly follow this format:

{
  "response": "[question]\\n\\nA) [Option A]\\n**B) [Option B]\\nC) [Option C]\\nD) [Option D]\\n\\n**Correct Answer: [Letter]**",
  "correct_answer": "[Letter]"
}`
        },
        { role: "user", content: prompt }
      ]
    });
  
  
    
    let message = response.choices[0]?.message?.content || 'No message returned';
    console.log(message);


    let parsedMessage;
    try {
      if (typeof message === 'string') {
        parsedMessage = JSON.parse(message);
      }
      console.log("Parsed Message:", message);
    } catch (error) {
      console.error("JSON Parsing Error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Failed to parse JSON response from OpenAI.",
        rawResponse: message,
      });
    }


    
    const combinedResponse = {
      user_prompt: prompt,
      response: parsedMessage.response,
      correct_answer: parsedMessage.correct_answer
    };


    const valuesToAppend = [[combinedResponse.response, combinedResponse.correct_answer]];
    const sheetName = 'Question'; // Ensure this is defined correctly
    console.log('Appending to sheet:', sheetName);
    console.log('Values to append:', valuesToAppend);
    await appendToSheet(valuesToAppend, sheetName); // Call the append function with the sheet name
    console.log("Response appended to Google Sheets!");


    // Append the new response to the existing array
    if (Array.isArray(message)) {
      lastResponse = lastResponse.concat(combinedResponse); // Merge arrays  
    } else {
      lastResponse.push(combinedResponse); // Add single object
    }

    res.status(200).json({
      success: true,
      message: "Response generated successfully.",
      data: combinedResponse
    });
  } catch (error) {
    console.error('OpenAI API Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to process the request.',
      error: error.response?.data || error.message,
    });
  }

  
});

app.get('/chat/response', async (req, res) =>  { //gets the info

  
    if (lastResponse) {
      res.status(200).json(lastResponse); // Send the stored JSON response
    } else {
      res.status(404).json({
        success: false,
        message: "No response available.",
      });
    }
  });

  let counting = 0;
// Add this at the module level (outside of any function)
let currentSheetRow = 0;
let currentPageRow = 0;

async function createDefaultSheet(spreadsheetId, sheetName) {
  try {
    const request = {
      spreadsheetId: spreadsheetId,
      resource: {
        requests: [{
          addSheet: {
            properties: {
              title: sheetName
            }
          }
        }],
      },
    };

    const response = await sheets.spreadsheets.batchUpdate(request);
    const newSheet = response.data.replies[0].addSheet.properties;
    console.log(`✅ New sheet created: ${newSheet.title}`);
    currentSheetRow = 0;
    currentPageRow = 0;

    return newSheet.title;
  } catch (error) {
    console.error('❌ Error creating sheet:', error.message);
    throw error;
  }
}

async function createDefault(spreadsheetId) {
  try {
    const request = {
      spreadsheetId: spreadsheetId,
      resource: {
        requests: [{ 
          addSheet: {} 
        }],
      },
    };

    const response = await sheets.spreadsheets.batchUpdate(request);
    const newSheet = response.data.replies[0].addSheet.properties;
    console.log(`✅ New sheet created: ${newSheet.title}`);
    currentSheetRow = 0;
    currentPageRow = 0;

    return newSheet.title;
  } catch (error) {
    console.error('❌ Error creating sheet:', error.message);
    throw error;
  }
}

// Next free row, found by counting how far column C is filled.
async function getNextRow(sheetName) {
  const colCheck = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!C:C`,
  });
  const existingRows = colCheck.data.values || [];
  return Math.max(2, existingRows.length + 1);
}

async function appendToSheet(values, sheetName, startRow) {
  if (!sheetName) {
    console.error('Sheet name is undefined. Please provide a valid sheet name.');
    return;
  }

  try {
    const nextRow = startRow || await getNextRow(sheetName);

    const targetRange = `${sheetName}!C${nextRow}`;

    const request = {
      spreadsheetId: SPREADSHEET_ID,
      range: targetRange,
      valueInputOption: 'RAW',
      resource: { values },
    };

    await sheets.spreadsheets.values.update(request);
    console.log(`✅ Data written to row ${nextRow}.`);
    return nextRow;
  } catch (error) {
    console.error('❌ Error writing to Google Sheets:', error.message);
  }
}

async function TwiceToSheet(values, sheetName) {
  if (!sheetName) {
    console.error('Sheet name is undefined. Please provide a valid sheet name.');
    return;
  }

  try {
    // Find the actual next empty row in column K
    const colCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!K:K`,
    });
    const existingRows = colCheck.data.values || [];
    const nextRow = Math.max(2, existingRows.length + 1);

    const targetRange = `${sheetName}!K${nextRow}`;

    const request = {
      spreadsheetId: SPREADSHEET_ID,
      range: targetRange,
      valueInputOption: 'RAW',
      resource: { values },
    };

    await sheets.spreadsheets.values.update(request);
    console.log(`✅ Data written to row ${nextRow}.`);
  } catch (error) {
    console.error('❌ Error writing to Google Sheets:', error.message);
  }
}

// Function to parse GPT's response
function parseGPTResponse(response) {
    const questionStart = response.indexOf('Question:') + 'Question:'.length;
    const questionEnd = response.indexOf('A)');
    const question = response.slice(questionStart, questionEnd).trim();

    const choicesStart = response.indexOf('A)');
    const choicesEnd = response.indexOf('Correct Answer:');
    const choicesAndAnswer = response.slice(choicesStart, choicesEnd).trim();

    const correctAnswerStart = response.indexOf('Correct Answer:') + 'Correct Answer:'.length;
    const correctAnswer = response.slice(correctAnswerStart).trim();

    return { question, choicesAndAnswer, correctAnswer };
}

// Fix the convertFormattingToMarkup function
function convertFormattingToMarkup(cell) {
  if (!cell || typeof cell !== 'object') {
    console.log('Invalid cell data:', cell);
    return '';
  }
  
  let text = cell.formattedValue || '';
  if (!text) {
    console.log('No formatted value found in cell');
    return '';
  }

  const format = cell.effectiveFormat?.textFormat || {};
  
  // Handle line breaks first
  text = text.replace(/\r?\n/g, '\\n');
  
  // Apply formatting in a specific order
  if (format.bold) text = `**${text}**`;
  if (format.italic) text = `*${text}*`;
  if (format.underline) text = `{${text}}`;
  
  // Escape quotes
  text = text.replace(/"/g, '\\"');
  
  console.log('Converted text:', text); // Debug log
  return text;
}

////////////////////////////////////////////////////////////////////
// Transcriber area

// function encodeImageToBase64(imagePath) {
//   const imageBuffer = fs.readFileSync(imagePath); // Read image as binary
//   return imageBuffer.toString("base64"); // Convert binary to Base64 string
// }

app.post('/transcribe', async (req, res) => {
  try {
    const files = await listFilesInFolder(FOLDER_ID);
    console.log(files);

    if (files.length === 0) {
      console.log('No files found in the folder.');
      return res.status(404).json({
        success: false,
        message: 'No files found in the folder.',
        details: {
          total_files: 0,
          processed_files: [],
          failed_files: [],
          sheet_name: null
        }
      });
    }

    // Find the first valid image file to use as sheet name
    const firstImageFile = files.find(file => 
      file.name.toLowerCase().endsWith('.png') || 
      file.name.toLowerCase().endsWith('.jpg') || 
      file.name.toLowerCase().endsWith('.jpeg')
    );

    if (!firstImageFile) {
      return res.status(400).json({
        success: false,
        message: 'No valid image files found in the folder.',
        details: {
          total_files: files.length,
          processed_files: [],
          failed_files: files.map(f => ({ name: f.name, reason: 'Not a valid image file' })),
          sheet_name: null
        }
      });
    }

    // Get filename without extension for sheet name
    const sheetName = firstImageFile.name.split('.').slice(0, -1).join('.');
    const newSheet = await createDefaultSheet(SPREADSHEET_ID, sheetName);

    console.log(`Found ${files.length} file(s) in the folder.`);

    const processedFiles = []; // To track successfully processed files
    const failedFiles = []; // To track failed files
    const localImagePaths = []; // To store paths of downloaded images

    // Clear the converted_images directory first
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.readdirSync(OUTPUT_DIR).forEach(file => {
        fs.unlinkSync(path.join(OUTPUT_DIR, file));
      });
    } else {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Download and save all valid images
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        console.log(`Skipping PDF file: ${file.name}`);
        failedFiles.push({ name: file.name, reason: 'PDF files are not supported in image mode' });
        continue;
      }

      if (!file.name.toLowerCase().endsWith('.png') && 
          !file.name.toLowerCase().endsWith('.jpg') && 
          !file.name.toLowerCase().endsWith('.jpeg')) {
        console.log(`Skipping unsupported file type: ${file.name}`);
        failedFiles.push({ name: file.name, reason: 'Unsupported file type' });
        continue;
      }

      try {
        // Download image from Google Drive
        const response = await drive.files.get(
          {
            fileId: file.id,
            alt: 'media',
            supportsAllDrives: true,
          },
          { responseType: 'stream' }
        );

        const localPath = path.join(OUTPUT_DIR, file.name);
        const writer = fs.createWriteStream(localPath);

        // Save the image locally
        await new Promise((resolve, reject) => {
          response.data
            .pipe(writer)
            .on('finish', resolve)
            .on('error', reject);
        });

        localImagePaths.push(localPath);
        processedFiles.push(file.name);
        console.log(`✅ Downloaded ${file.name} to ${localPath}`);
      } catch (error) {
        console.error(`Error downloading file ${file.name}:`, error.message);
        failedFiles.push({ name: file.name, reason: error.message });
      }
    }

    // Process all downloaded images using the transcribeImages function
    const responses = await transcribeImages(localImagePaths, newSheet);

    // Generate unique filename and process Excel file
    const uniqueFileName = generateUniqueFileName(newSheet);
    await exportSheetToXLSX(SPREADSHEET_ID, newSheet, uniqueFileName);
    await uploadXLSXToDrive(uniqueFileName, EXPORT_FOLDER_ID);
    
    // Clean up temporary files
    try {
      fs.unlinkSync(uniqueFileName);
      console.log(`✅ Cleaned up temporary file: ${uniqueFileName}`);
      
      // Clean up downloaded images
      localImagePaths.forEach(imagePath => {
        fs.unlinkSync(imagePath);
        console.log(`✅ Cleaned up image file: ${imagePath}`);
      });
    } catch (error) {
      console.error(`❌ Error cleaning up files: ${error.message}`);
    }

    // Return detailed success response
    return res.status(200).json({
      success: true,
      message: `Successfully processed ${processedFiles.length} files and created sheet "${newSheet}"`,
      details: {
        total_files: files.length,
        processed_files: processedFiles,
        failed_files: failedFiles,
        sheet_name: newSheet
      },
      data: responses,
    });

  } catch (error) {
    console.error('Error in transcribe endpoint:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'An unexpected error occurred while processing files.',
      details: {
        type: error.name,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        total_files: 0,
        processed_files: [],
        failed_files: [],
        sheet_name: null
      }
    });
  } 
});

////////////////////////////////////////////////////////////////////
// PDF AREA
////////////////////////////////////////////////////////////////////

async function clearProcessingQueue() {
  try {
    console.log("🛑 Clearing previous processing queue...");

    if (fs.existsSync(OUTPUT_DIR)) {
      fs.readdirSync(OUTPUT_DIR).forEach(file => {
        if (file.endsWith(".png")) {
          fs.unlinkSync(path.join(OUTPUT_DIR, file));
        }
      });
      console.log("✅ Local queue cleared: Deleted old converted images.");
    } else {
      console.log("📂 No local images to clear.");
    }

    console.log("🚀 Processing queue cleared. Ready for new tasks.");
  } catch (error) {
    console.error("❌ Error clearing processing queue:", error.message);
  }
}

// Render resolution for page images. Figure crops reuse it so that the
// point -> pixel conversion matches the pages the model was shown.
const PDF_RENDER_DPI = 150;

// Thumbnails only need to be legible enough to tell prose from equations.
const THUMBNAIL_DPI = 40;

// Pages in flight at once. Transcription is almost entirely spent waiting on the
// model, so this is about latency, not CPU.
const TRANSCRIBE_CONCURRENCY = 5;

// Cached transcriptions outlive a run, so they cannot live in OUTPUT_DIR — that
// folder is emptied every time processing starts.
const CACHE_DIR = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, 'transcription-cache')
  : path.join(__dirname, '.transcription-cache');

// Resolve the pdftocairo (poppler) binary in a cross-platform way.
// Precedence: POPPLER_PATH env > bundled vendor binary > common system paths > PATH.
function resolvePdftocairo() {
  const binName = process.platform === 'win32' ? 'pdftocairo.exe' : 'pdftocairo';

  // 1. Explicit override
  if (process.env.POPPLER_PATH) {
    const p = path.join(process.env.POPPLER_PATH, binName);
    if (fs.existsSync(p)) return p;
  }

  // 2. Optional vendor override (vendor/poppler/<platform>-<arch>/bin/<bin>) —
  // drop a native/newer binary here to take precedence over the npm-bundled one.
  const platformDir = `${process.platform}-${process.arch}`;
  const baseDirs = isPackaged
    ? [path.join(process.resourcesPath || __dirname, 'vendor', 'poppler')]
    : [path.join(__dirname, 'vendor', 'poppler')];
  for (const base of baseDirs) {
    const p = path.join(base, platformDir, 'bin', binName);
    if (fs.existsSync(p)) return p;
  }

  // 3. Binaries shipped inside the pdf-poppler npm package (bundled automatically
  // by electron-builder). Works out of the box, no manual download needed.
  const pdfPopplerBins = process.platform === 'win32'
    ? [path.join(__dirname, 'node_modules', 'pdf-poppler', 'lib', 'win', 'poppler-0.51', 'bin', binName)]
    : [
        path.join(__dirname, 'node_modules', 'pdf-poppler', 'lib', 'osx', 'poppler-0.66', 'bin', binName),
        path.join(__dirname, 'node_modules', 'pdf-poppler', 'lib', 'osx', 'poppler-0.62', 'bin', binName),
      ];
  for (const p of pdfPopplerBins) {
    if (fs.existsSync(p)) return p;
  }

  // 4. Common system install locations
  const commonPaths = process.platform === 'win32'
    ? ['C:\\Program Files\\poppler\\Library\\bin', 'C:\\poppler\\Library\\bin']
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of commonPaths) {
    const p = path.join(dir, binName);
    if (fs.existsSync(p)) return p;
  }

  // 5. Last resort: rely on PATH
  console.warn('⚠️ pdftocairo not found in vendor/ or common paths; falling back to PATH.');
  return binName;
}

// Convert PDF to Images
async function convertPdfToImages(pdfPath, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const pdftocairo = resolvePdftocairo();
  const outPrefix = path.join(outputDir, 'page');
  const cmd = `"${pdftocairo}" -png -r ${PDF_RENDER_DPI} "${pdfPath}" "${outPrefix}"`;

  try {
    console.log(`Converting PDF: ${pdfPath} to images...`);
    await execAsync(cmd);

    // Every page is kept. Work is bounded by question capacity further down the
    // pipeline, not by a page count — an exam that prints one question per page
    // needs ~99 pages to hold 98 questions, and capping pages here silently threw
    // the back half of such a PDF away.
    const images = fs.readdirSync(outputDir)
      .filter((file) => file.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    console.log(`✅ Converted ${images.length} pages to images.`);
    return images.map((img) => path.join(outputDir, img));
  } catch (error) {
    console.error("❌ Error converting PDF:", error);
    throw error;
  }
}

// Upload Images to Google Drive
async function uploadFileToDrive(filePath) {
  try {
    const fileMetadata = {
      name: path.basename(filePath),
      parents: [FOLDER_PDF],
    };

    const media = {
      mimeType: "image/png",
      body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: "id",
      supportsAllDrives: true,
    });

    console.log(`✅ Uploaded ${filePath} to Google Drive with ID: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    console.error("❌ Error uploading file to Google Drive:", error);
    throw error;
  }
}

async function downloadPdfFromDrive(fileId) {
  try {
    const response = await drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      { responseType: 'stream' }
    );

    // Use the OUTPUT_DIR for saving files
    const filePath = path.join(OUTPUT_DIR, `${fileId}.pdf`);
    const dest = fs.createWriteStream(filePath);
    response.data.pipe(dest);

    return new Promise((resolve, reject) => {
      dest.on('finish', () => {
        console.log(`✅ Downloaded PDF to: ${filePath}`);
        resolve(filePath);
      });
      dest.on('error', reject);
    });
  } catch (error) {
    console.error('❌ Error downloading PDF from Google Drive:', error.message);
    throw error;
  }
}

// Function to list PDF files in a Google Drive folder
async function listPdfFilesInFolder(folderId) {
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (!response.data || !response.data.files) {
      throw new Error('No data returned from Google Drive API.');
    }

    return response.data.files;
  } catch (error) {
    console.error('Error listing PDF files in folder:', error.message);
    throw error;
  }
}

// Everything that happens to a single PDF once it is sitting on disk, whether it
// arrived from the Drive folder or was dropped onto the app.
async function processOnePdf(pdfFilePath, displayName) {
  const sheetName = displayName.replace(/\.pdf$/i, '');
  const newSheetName = await createDefaultSheet(SPREADSHEET_ID, sheetName);

  const images = await convertPdfToImages(pdfFilePath, OUTPUT_DIR);

  for (const image of images) {
    await uploadFileToDrive(image);
  }
  console.log(`✅ All images from ${displayName} uploaded to Google Drive.`);

  const { mathStartPage, expected } = await detectMathStartPage(pdfFilePath);
  const responses = await transcribeImages(images, newSheetName, pdfFilePath, mathStartPage, expected);

  return { sheetName: newSheetName, responses };
}

async function processPdfAndUpload() {
  const failures = [];
  try {
    await clearProcessingQueue();

    const pdfFiles = await listPdfFilesInFolder(FOLDER_PDF);
    pdfFiles.sort((a, b) => a.name.localeCompare(b.name));

    for (const pdfFile of pdfFiles) {
      console.log(`Processing PDF file: ${pdfFile.name} (${pdfFile.id})`);

      const pdfFilePath = await downloadPdfFromDrive(pdfFile.id);
      const { sheetName, responses } = await processOnePdf(pdfFilePath, pdfFile.name);

      for (const r of responses) {
        if (r.error) {
          failures.push({ sheet: sheetName, image: r.image, error: r.error });
        }
      }
    }

    await listFilesInFolder(FOLDER_PDF);
  } catch (error) {
    // Throw the error to be caught by the endpoint
    throw error;
  }
  return failures;
}

// --- Graph extraction ------------------------------------------------------
// Questions the model marks with %GRAPH% have their figure cropped out of the
// PDF, uploaded to Drive, and linked into the sheet as an =IMAGE() thumbnail.

// Response shapes are enforced by the API rather than requested in prose, so the
// model cannot return stray commentary, several objects in a row, or several
// fenced blocks — the shapes that used to drop whole pages of questions.
const TRANSCRIPTION_SCHEMA = {
  name: 'exam_page',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        description: 'One entry per question printed on the page, in reading order.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question_number', 'continues_previous_page', 'section', 'passage', 'question', 'correct_answer'],
          properties: {
            question_number: {
              type: ['integer', 'null'],
              description: 'The number printed beside the question, or null if none is shown.',
            },
            continues_previous_page: {
              type: 'boolean',
              description: 'True when this is the tail of a question that began on the previous page.',
            },
            section: { type: 'string', enum: ['Reading and Writing', 'Math'] },
            passage: { type: 'string', description: 'Stimulus only. Empty string when there is none.' },
            question: { type: 'string', description: 'Prompt sentence, then the answer choices.' },
            correct_answer: { type: 'string', description: 'A single letter A-D, or the answer value for a question with no choices.' },
          },
        },
      },
    },
  },
};

// These extra fields are expectations, never instructions. Nothing branches on
// them; they are compared against what the pages actually produced so a short or
// misread run is reported rather than quietly written.
const STRUCTURE_SCHEMA = {
  name: 'exam_structure',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['math_start_page', 'questions_per_page', 'total_questions'],
    properties: {
      math_start_page: {
        type: ['integer', 'null'],
        description: '1-based page number of the first page holding a math question.',
      },
      questions_per_page: {
        type: ['integer', 'null'],
        description: 'Typical number of questions printed on one page, or null if it varies.',
      },
      total_questions: {
        type: ['integer', 'null'],
        description: 'Total questions in the whole exam, counting both sections.',
      },
    },
  },
};

// Older API snapshots reject json_schema. If that happens the model still works
// unconstrained, and the recovery parser picks up the slack, so fall back once
// rather than failing every page of the run.
let structuredOutputsSupported = true;

async function askModel(content, schema) {
  const request = { model: 'gpt-4o', messages: [{ role: 'user', content }], store: true };

  if (structuredOutputsSupported) {
    try {
      const response = await openai.chat.completions.create({
        ...request,
        response_format: { type: 'json_schema', json_schema: schema },
      });
      return response.choices[0]?.message?.content || '';
    } catch (error) {
      if (!/response_format|json_schema/i.test(error.message || '')) throw error;
      console.warn('⚠️ This model rejects json_schema; continuing without it for the rest of the run.');
      structuredOutputsSupported = false;
    }
  }

  const response = await openai.chat.completions.create(request);
  return response.choices[0]?.message?.content || '';
}

// Low-resolution thumbnails of every page, cheap enough to send all at once.
// They go in a subfolder because convertPdfToImages globs OUTPUT_DIR for *.png
// and would otherwise transcribe them as if they were pages.
async function renderThumbnails(pdfPath) {
  const thumbDir = path.join(OUTPUT_DIR, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  for (const f of fs.readdirSync(thumbDir)) fs.unlinkSync(path.join(thumbDir, f));

  const cmd = `"${resolvePdftocairo()}" -png -r ${THUMBNAIL_DPI} "${pdfPath}" "${path.join(thumbDir, 'thumb')}"`;
  await execAsync(cmd);

  return fs.readdirSync(thumbDir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => path.join(thumbDir, f));
}

// One pass over the whole exam to find where the math modules begin. Returns a
// 1-based page number, or null if it cannot be determined.
async function detectMathStartPage(pdfPath) {
  try {
    const thumbnails = await renderThumbnails(pdfPath);
    if (!thumbnails.length) return null;

    console.log(`🔎 Structure pass over ${thumbnails.length} page thumbnails...`);

    const content = [{
      type: 'text',
      text: `These are thumbnails of every page of an SAT practice exam, in order, starting at page 1.
        The exam is laid out as Reading and Writing modules first, then Math modules. Reading and Writing
        pages are dense with prose passages. Math pages are dominated by equations, numerals, geometric
        figures, and coordinate grids, and often carry a "Math" module heading.
        Identify the 1-based page number of the FIRST page that contains a Math question.
        Also report how many questions a page typically holds — use null if it varies from page to page —
        and how many questions the whole exam contains across both sections.`,
    }];

    for (const thumb of thumbnails) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${fs.readFileSync(thumb, { encoding: 'base64' })}`,
          detail: 'low', // ~85 tokens per page instead of ~1100
        },
      });
    }

    const parsed = parseTranscriptionResponse(await askModel(content, STRUCTURE_SCHEMA))[0] || {};
    const page = Number(parsed.math_start_page);
    const expected = {
      questionsPerPage: Number.isInteger(parsed.questions_per_page) ? parsed.questions_per_page : null,
      totalQuestions: Number.isInteger(parsed.total_questions) ? parsed.total_questions : null,
      pageCount: thumbnails.length,
    };

    console.log(`📐 Expecting ~${expected.totalQuestions ?? '?'} question(s) across ${expected.pageCount} page(s)`
      + `, ${expected.questionsPerPage ?? 'a varying number'} per page.`);

    if (!Number.isInteger(page) || page < 2 || page > thumbnails.length) {
      console.warn(`⚠️ Structure pass returned an unusable math start page (${parsed.math_start_page}); falling back to the row rule.`);
      return { mathStartPage: null, expected };
    }

    console.log(`📐 Math section starts on page ${page} of ${thumbnails.length}.`);
    return { mathStartPage: page, expected };
  } catch (error) {
    console.error('⚠️ Structure pass failed; falling back to the row rule:', error.message);
    return { mathStartPage: null, expected: null };
  }
}

// Transcriptions are cached on disk so a run that dies partway can be repeated
// without paying for the pages that already succeeded. The cache lives outside
// OUTPUT_DIR because that folder is wiped at the start of every run.
function cacheKeyForPdf(pdfPath) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(pdfPath)).digest('hex').slice(0, 16);
  } catch (error) {
    return null;
  }
}

function cachePathFor(pdfKey, image) {
  return path.join(CACHE_DIR, pdfKey, `${path.basename(image, path.extname(image))}.json`);
}

function readTranscriptionCache(pdfKey, image) {
  if (!pdfKey) return null;
  try {
    const file = cachePathFor(pdfKey, image);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null; // a corrupt entry just means transcribing the page again
  }
}

// The cache exists to survive a crash, not to remember a PDF forever. Dropping it
// once every page has been transcribed and written means re-uploading the same
// file gives a genuinely fresh read — which is what you want when the previous
// parse came out wrong — while an interrupted run still resumes for free.
function clearTranscriptionCache(pdfKey) {
  if (!pdfKey) return;
  try {
    fs.rmSync(path.join(CACHE_DIR, pdfKey), { recursive: true, force: true });
    console.log('🧹 Run finished cleanly; cleared its transcription cache.');
  } catch (error) {
    console.warn('⚠️ Could not clear transcription cache:', error.message);
  }
}

function writeTranscriptionCache(pdfKey, image, questions) {
  if (!pdfKey) return;
  try {
    const file = cachePathFor(pdfKey, image);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(questions));
  } catch (error) {
    console.warn('⚠️ Could not cache transcription:', error.message);
  }
}

// Phase one: page in, questions out. Touches no shared state, so it is safe to
// run several of these at once.
async function transcribePage(image, pdfKey) {
  const cached = readTranscriptionCache(pdfKey, image);
  if (cached) {
    console.log(`♻️  ${path.basename(image)}: reusing cached transcription (${cached.length} question(s)).`);
    return cached;
  }

  console.log(`Transcribing image: ${image}`);
  const base64Image = fs.readFileSync(image, { encoding: 'base64' });

  const newMessage = await askModel([
        {
          type: "text",
          text: `You transcribe the passages and questions printed on the page shown. Add one entry per question, in the order they appear on the page; a page often holds more than one.
            Carefully analyze the photo and encapsulate accordingly. Do not confuse "  with each other. There can be multiple in one question. Use \\n for single line breaks and \\n\\n for double line breaks.
            If there is a graph, write %GRAPH% at the beginning of the question. If there are any italics, use *text*. If there are any quotes, use "text". STRICTLY FOLLOW: If there are any underlines, use {text}.
            "section" is "Math" when the question turns on equations, numbers, graphs, or mathematical reasoning, and "Reading and Writing" when it is built on a passage or literary text.
            For Math questions: write every equation, expression, fraction, exponent, radical, or inequality as LaTeX wrapped in single dollar signs, e.g. $x^2 + \\\\frac{3}{4} \\\\leq 12$. Math questions usually have no passage; leave "passage" as an empty string in that case.
            "correct_answer" is STRICTLY a single capital letter — A, B, C, or D — and nothing else. Never the text of the choice, never the letter and the text together. The ONLY exception is a question that prints no answer choices at all (a student-produced response, which only happens in Math): there, and only there, put the answer value itself, such as 7 or 3/4 or 0.25.
            If a question has no answer choices at all, omit the "\\n\\nA) ... D)" block entirely and put only the question text in "question".
            Report the number printed beside each question in "question_number"; use null if the page shows no number for it.
            A question is often split by a page break. If this page BEGINS with answer choices belonging to a question whose text is on the previous page, return that as a single entry with "continues_previous_page" set to true, "question" holding just those choices, and everything else empty — do not invent a question or a passage for it, and do not count it as a new question. Never invent answer choices for a question whose choices are not printed on this page: leave them out and let the next page supply them. For every question that genuinely starts on this page, "continues_previous_page" is false.
            If the answer choices are themselves graphs, diagrams, number lines, or pictures rather than text, write %CHOICES_GRAPH% at the very beginning of the "question" field, then still transcribe the full question text after it, and leave out the "\\n\\nA) ... D)" block since there is no choice text to transcribe. The marker replaces the choices, never the question itself.
            Keep the two text fields strictly separate. "passage" holds ONLY the stimulus the question is about — the reading text, excerpt, table, or graph description printed above the prompt. Never put the prompt sentence in "passage"; if a question has no stimulus, use an empty string. "question" holds the prompt sentence (the part that asks something, e.g. "Which choice completes the text...?") followed by the answer choices, formatted as "[question]\\n\\nA) [Option A]\\nB) [Option B]\\nC) [Option C]\\nD) [Option D]". Never start "question" with "A)".`,
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${base64Image}` },
        },
  ], TRANSCRIPTION_SCHEMA);

  console.log("Raw GPT Response:", newMessage);

  const questions = parseTranscriptionResponse(newMessage);
  console.log(`Parsed ${questions.length} question(s) from ${path.basename(image)}.`);

  writeTranscriptionCache(pdfKey, image, questions);
  return questions;
}

// Function to transcribe images
async function transcribeImages(images, sheetName, pdfPath, mathStartPage, expected) {
  const responses = [];
  const pdfKey = pdfPath ? cacheKeyForPdf(pdfPath) : null;

  // Phase one runs concurrently: it only calls the model and touches the cache.
  // Pages are taken in batches so transcription can stop once enough questions
  // exist to fill the template, instead of paying for pages nothing can hold.
  console.log(`🚀 Transcribing up to ${images.length} page(s), ${TRANSCRIBE_CONCURRENCY} at a time...`);
  const transcribed = [];
  let questionsSoFar = 0;

  for (let i = 0; i < images.length; i += TRANSCRIBE_CONCURRENCY) {
    if (questionsSoFar >= QUESTION_CAPACITY) {
      console.warn(`⏹️  Stopping after ${transcribed.length} page(s): the template's ${QUESTION_CAPACITY} question slots are full, so pages beyond this cannot be written.`);
      break;
    }

    const batch = images.slice(i, i + TRANSCRIBE_CONCURRENCY);
    const done = await mapWithConcurrency(batch, TRANSCRIBE_CONCURRENCY, async (image) => {
      try {
        return { image, questions: await transcribePage(image, pdfKey) };
      } catch (error) {
        console.error(`Error processing image ${path.basename(image)}:`, error.message);
        return { image, error: error.message };
      }
    });

    transcribed.push(...done);
    questionsSoFar += done.reduce((n, page) => n + (page.questions ? page.questions.length : 0), 0);
  }

  // Questions split by a page break are rejoined before anything is counted, so
  // the tail of one does not get written as a question in its own right.
  const stitched = mergePageContinuations(transcribed);

  // Phase two is strictly sequential and in page order, because every row the
  // sheet hands out depends on how many rows were handed out before it.
  for (const page of stitched) {
    const { image } = page;

    if (page.error) {
      responses.push({ image, error: page.error });
      continue;
    }

    try {
      let parseMessage = page.questions;

        // Where this page's questions go, and whether they go at all. All the
        // block arithmetic lives in planPageWrite so it can be tested directly.
        const pageNumber = pageNumberFromImage(image);
        const plan = planPageWrite({
          questions: parseMessage,
          pageNumber,
          nextRow: await getNextRow(sheetName),
          mathStartPage,
        });

        for (const note of plan.notes) console.warn(note);

        if (plan.action === 'skip') {
          responses.push({ image, skipped: plan.reason });
          continue;
        }

        if (plan.action === 'stop') {
          const from = stitched.indexOf(page);
          console.warn(`⏹️  ${stitched.length - from} page(s) were not written.`);
          for (const rest of stitched.slice(from)) {
            responses.push({ image: rest.image, skipped: plan.reason });
          }
          break;
        }

        const { startRow, isMathPage } = plan;
        parseMessage = plan.questions;

        const valuesToAppend = parseMessage.map((raw, i) => {
          // Recover the question when the model put all of it in the passage.
          const q = salvageQuestionFields(raw);
          if (!raw.question && q.question) {
            console.warn(`⚠️ Row ${startRow + i}: the question was inside the passage; split it back out.`);
          }
          console.log("RAW QUESTION:", JSON.stringify(q.question));
          let { stem, choiceA, choiceB, choiceC, choiceD } = parseQuestion(q.question);

          // Picture answer choices have no text to transcribe, so the columns are
          // marked instead of left blank — a reviewer can see at a glance that the
          // choices live in the source PDF rather than assuming they went missing.
          if (questionHasChoiceGraphs(q)) {
            [choiceA, choiceB, choiceC, choiceD] = Array(4).fill(CHOICE_IMAGE_LABEL);
            // The marker is a routing signal, not part of the question, so it is
            // taken back out of the stem before the row is written.
            stem = stem.split(CHOICE_GRAPH_MARKER).join('').trim();
            if (!stem) {
              console.warn(`⚠️ Row ${startRow + i}: the transcriber returned only ${CHOICE_GRAPH_MARKER} with no question text.`);
            }
          }

          // The model returns the choice's text as often as its letter, so the
          // letter is recovered from the choices rather than taken on trust.
          const { answer, matched } = normaliseAnswer(q.correct_answer, [choiceA, choiceB, choiceC, choiceD]);
          if (!matched) {
            console.warn(`⚠️ Row ${startRow + i}: answer ${JSON.stringify(q.correct_answer)} matches none of the choices; left as is.`);
          }

          const section = sectionFor(startRow + i);
          if (q.section && !q.section.toLowerCase().startsWith(section.slice(0, 4).toLowerCase())) {
            console.warn(`⚠️ Row ${startRow + i}: transcriber said "${q.section}", position says "${section}" — using position.`);
          }
          return [section, q.passage || '', stem, choiceA, choiceB, choiceC, choiceD, answer];
        });

        await appendToSheet(valuesToAppend, sheetName, startRow);

        console.log(`Response for image appended to Google Sheets!`);
        responses.push({
          image: image,
          response: parseMessage,
        });
    } catch (error) {
      console.error(`Error writing ${path.basename(image)} to the sheet:`, error.message);
      responses.push({
        image: image,
        error: error.message,
      });
    }
  }

  reportRunHealth(stitched, responses, expected, sheetName);

  if (!responses.some(r => r.error)) {
    clearTranscriptionCache(pdfKey);
  } else {
    console.log('📌 Keeping the transcription cache: re-running this PDF will resume the failed pages only.');
  }

  // Generate unique filename
  const uniqueFileName = generateUniqueFileName(sheetName);

  await exportSheetToXLSX(SPREADSHEET_ID, sheetName, uniqueFileName);
  await uploadXLSXToDrive(uniqueFileName, EXPORT_FOLDER_ID);
  
  await processExcelFile(uniqueFileName, sheetName)
    .then(result => console.log('Final JSON result:', JSON.stringify(result, null, 2)))
    .catch(error => console.error('Processing failed:', error.message));

  // Optionally, clean up the local file after processing
  try {
    fs.unlinkSync(uniqueFileName);
    console.log(`✅ Cleaned up temporary file: ${uniqueFileName}`);
  } catch (error) {
    console.error(`❌ Error cleaning up file: ${error.message}`);
  }

  return responses;
}

// Example usage
const filePath = 'output.xlsx'; // Replace with the actual file path

// Function to get the file ID from Google Drive
async function getFileIdFromDrive(fileName) {
  try {
    const response = await drive.files.list({
      q: `name = '${path.basename(fileName)}' and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = response.data.files;
    if (files.length > 0) {
      return files[0].id;
    } else {
      throw new Error(`File not found: ${fileName}`);
    }
  } catch (error) {
    console.error('❌ Error retrieving file ID from Google Drive:', error.message);
    throw error;
  }
}

// --- Dropped files ---------------------------------------------------------
// Uploads arrive as the raw file body rather than multipart form data, which
// keeps this dependency-free: fetch(url, { method: 'POST', body: file }) sends a
// File as bytes, and the name travels in the query string.

const STAGING_DIR = path.join(OUTPUT_DIR, 'staged');

// Reject path traversal from a crafted ?name= and keep the extension we expect.
function safeUploadName(raw, fallback, allowed) {
  const base = path.basename(String(raw || '')).replace(/[^\w.\- ]/g, '_');
  const ext = path.extname(base).toLowerCase();
  return base && allowed.includes(ext) ? base : fallback;
}

app.post('/upload-pdf', express.raw({ type: 'application/pdf', limit: '250mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ success: false, message: 'No PDF received.' });
    }

    const name = safeUploadName(req.query.name, 'upload.pdf', ['.pdf']);
    console.log(`📥 Received ${name} (${(req.body.length / 1e6).toFixed(1)} MB)`);

    await clearProcessingQueue();

    const pdfFilePath = path.join(OUTPUT_DIR, name);
    fs.writeFileSync(pdfFilePath, req.body);

    const { sheetName, responses } = await processOnePdf(pdfFilePath, name);
    const failures = responses.filter(r => r.error).map(r => ({ sheet: sheetName, image: r.image, error: r.error }));

    res.status(200).json({
      success: failures.length === 0,
      sheetName,
      pages: responses.length,
      message: failures.length
        ? `Transcribed "${sheetName}" with ${failures.length} page(s) failing.`
        : `Transcribed "${sheetName}" into a new sheet.`,
      failures,
    });
  } catch (error) {
    console.error('Error processing uploaded PDF:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to process the PDF.' });
  }
});

// Images are staged one request at a time, then transcribed together so they all
// land in a single sheet.
app.post('/upload-image', express.raw({ type: ['image/png', 'image/jpeg'], limit: '50mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ success: false, message: 'No image received.' });
    }

    if (req.query.reset === 'true' && fs.existsSync(STAGING_DIR)) {
      fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(STAGING_DIR, { recursive: true });

    const name = safeUploadName(req.query.name, `image-${Date.now()}.png`, ['.png', '.jpg', '.jpeg']);
    fs.writeFileSync(path.join(STAGING_DIR, name), req.body);

    res.status(200).json({ success: true, staged: fs.readdirSync(STAGING_DIR).length });
  } catch (error) {
    console.error('Error staging image:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to stage the image.' });
  }
});

app.post('/transcribe-uploaded', async (req, res) => {
  try {
    if (!fs.existsSync(STAGING_DIR)) {
      return res.status(400).json({ success: false, message: 'No images have been uploaded.' });
    }

    const images = fs.readdirSync(STAGING_DIR)
      .filter(f => /\.(png|jpe?g)$/i.test(f))
      .sort()
      .map(f => path.join(STAGING_DIR, f));

    if (!images.length) {
      return res.status(400).json({ success: false, message: 'No images have been uploaded.' });
    }

    const sheetName = await createDefault(SPREADSHEET_ID);
    const responses = await transcribeImages(images, sheetName);
    const failures = responses.filter(r => r.error);

    fs.rmSync(STAGING_DIR, { recursive: true, force: true });

    res.status(200).json({
      success: failures.length === 0,
      sheetName,
      processed: responses.length,
      message: failures.length
        ? `Transcribed ${responses.length} image(s) with ${failures.length} failing.`
        : `Transcribed ${responses.length} image(s) into "${sheetName}".`,
      failures,
    });
  } catch (error) {
    console.error('Error transcribing uploaded images:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to transcribe the images.' });
  }
});

app.post('/process-pdf', async (req, res) => {
  try {
    const failures = await processPdfAndUpload();
    if (failures.length > 0) {
      res.status(200).json({
        success: false,
        message: `Processed with ${failures.length} image(s) failing to transcribe. See details.`,
        failures,
      });
    } else {
      res.status(200).json({
        success: true,
        message: 'All PDFs have been processed successfully.',
      });
    }
} catch (error) {
    console.error('Error processing PDFs:', error);
    res.status(500).json({
    success: false,
      message: error.message || 'Failed to process PDFs.',
  });
} 
});

async function deleteFileByName(fileName) {
  try {
    // Step 1: Search for the file by name
    const response = await drive.files.list({
      q: `name = '${fileName}' and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = response.data.files;

    if (!files.length) {
      console.log(`No file found with name: ${fileName}`);
      return;
    }

    // Step 2: Delete each matching file (if multiple exist with the same name)
    for (const file of files) {
      await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
      console.log(`✅ Deleted file: ${file.name} (${file.id})`);
    }
  } catch (error) {
    console.error('❌ Error deleting file:', error.message);
  }
}

async function clearOldDriveFiles(folderId) {
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = response.data.files;

    if (!files.length) {
      console.log(`No files found in folder: ${folderId}`);
      return;
    }

    for (const file of files) {
      await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
      console.log(`✅ Deleted file: ${file.name} (${file.id})`);
    }
  } catch (error) {
    console.error('❌ Error clearing files from Google Drive:', error.message);
  }
}

async function exportSheetToXLSX(spreadsheetId, sheetName, destinationPath) {
  try {
      const auth = new google.auth.GoogleAuth({
          keyFile: SERVICE_ACCOUNT_FILE,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });

      const sheets = google.sheets({ version: 'v4', auth });

      // Fetch data from the specified sheet tab with more complete fields
      const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!A:M`,
          valueRenderOption: 'FORMATTED_VALUE'
      });

      const rows = response.data.values || [];
      if (!rows || rows.length === 0) {
          throw new Error(`No data found in sheet "${sheetName}".`);
      }

      // Convert the data to an XLSX format
      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      // Excel worksheet names can't contain : \ / ? * [ ] — the Google Sheets
      // tab name may, so sanitize just for this local XLSX export.
      const xlsxSheetName = sheetName.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
      XLSX.utils.book_append_sheet(workbook, worksheet, xlsxSheetName);

      // Save to an XLSX file
      XLSX.writeFile(workbook, destinationPath);
      
      // Verify file was created
      if (!fs.existsSync(destinationPath)) {
          throw new Error(`Failed to create file at ${destinationPath}`);
      }
      
      console.log(`✅ Sheet "${sheetName}" exported to ${destinationPath}`);
      return true;
  } catch (error) {
      console.error('❌ Error exporting sheet to XLSX:', error.message);
      throw error;
  }
}

// Function to upload a file (XLSX, PNG, or any type) to Google Drive
async function uploadXLSXToDrive(filePath, folderId) {
  try {
    const fileName = path.basename(filePath);
    const fileExtension = path.extname(filePath).toLowerCase();


    // Set MIME type based on file extension
    let mimeType;
    if (fileExtension === '.xlsx') {
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (fileExtension === '.png') {
      mimeType = 'image/png';
    } else if (fileExtension === '.jpg' || fileExtension === '.jpeg') {
      mimeType = 'image/jpeg';
    } else {
      throw new Error(`Unsupported file type: ${fileExtension}`);
    }

    const fileMetadata = {
      name: fileName,
      parents: [folderId], // Upload to the specified Google Drive folder
    };

    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: "id",
      supportsAllDrives: true,
    });

    console.log(`✅ Uploaded ${fileName} to Google Drive with ID: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    console.error("❌ Error uploading file to Google Drive:", error.message);
    throw error;
  }
}

async function processExcelFile(filePath, sheetName) {
  try {
    const data = fs.readFileSync(filePath);
    const workbook = XLSX.read(data, {
      type: 'buffer',
      cellStyles: true,
      cellNF: true,
      cellFormula: true,
      cellHTML: true,
      raw: false
    });

    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false
    });

    if (jsonData.length < 2) {
      throw new Error('No valid data found in Excel file.');
    }

    const results = [];
    // Column C is written from the question's position in the exam rather than
    // from the transcriber's guess, so it can be trusted here. The latch is kept
    // because math never gives way back to Reading and Writing: if one row in the
    // math block is somehow blank or wrong, the rows after it stay math.
    let inMathSection = false;

    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row) continue;

      if (!row[2] && !row[3] && !row[4]) continue; // Skip if C, D, E are all empty

      if (/^\s*math/i.test(row[2] || '')) inMathSection = true;

      // C=section, D=passage, E=stem, F=choiceA, G=choiceB, H=choiceC, I=choiceD, J=answer
      // Reconstruct with A) B) C) D) labels to match model training format
      const choicesText = [
        row[5] ? `A) ${row[5]}` : '',
        row[6] ? `B) ${row[6]}` : '',
        row[7] ? `C) ${row[7]}` : '',
        row[8] ? `D) ${row[8]}` : '',
      ].filter(p => p).join('\n');

      const question = `${row[3] || ''}\n\n${row[4] || ''}\n\n${choicesText}`.trim();

      // The classifier is trained on Reading and Writing only, so math rows skip it.
      // 'N/A' rather than '' because TwiceToSheet finds its next row by counting
      // non-empty cells in column K — blanks would knock the rows out of alignment.
      if (inMathSection) {
        results.push({
          question,
          passageType: 'N/A',
          questionType: 'N/A',
          difficultyLevel: 'N/A'
        });
        continue;
      }

      try {
        const response = await fetch('http://localhost:5001/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question })
        });

        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();
        console.log('Classification result:', data);

        if (!data.success) {
          throw new Error(data.error || 'Classification failed');
        }

        // Split the classification into three parts
        const [passageType, questionType, difficultyLevel] = data.classification
          .split('|')
          .map(part => part.trim().split(': ')[1]); // Get the value after ':'

        results.push({
          question,
          passageType,
          questionType,
          difficultyLevel
        });

      } catch (error) {
        console.error('Error processing row:', error);
        results.push({
          question,
          passageType: 'Error',
          questionType: 'Error',
          difficultyLevel: 'Error'
        });
      }
    }

    // Format classifications as three separate columns
    const classificationsToAppend = results.map(result => [
      result.passageType,
      result.questionType,
      result.difficultyLevel
    ]);

    // Append classifications to sheet
    await TwiceToSheet(classificationsToAppend, sheetName);

    return results;

  } catch (error) {
    console.error('Error processing file:', error.message);
    return { error: error.message };
  }
}

// Example usage:
// await exportSheetToXLSX('Sheet1', 'your_folder_id');

app.post('/export-sheet', async (req, res) => {
  try {
    const { sheetName } = req.body;
    const exportFolderId = 'YOUR_EXPORT_FOLDER_ID'; // Replace with your folder ID
    
    const fileId = await exportSheetToXLSX(sheetName, exportFolderId);
    
    res.status(200).json({
      success: true,
      message: `Sheet "${sheetName}" exported successfully`,
      fileId: fileId
    });
  } catch (error) {
    console.error('Error exporting sheet:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export sheet',
      error: error.message
    });
  }
});

// Add this endpoint to handle sheet downloads
app.post('/download-sheet', async (req, res) => {
  try {
    const { sheetName } = req.body;
    if (!sheetName) {
      throw new Error('Sheet name is required');
    }

    // Generate unique filename for this download
    const uniqueFileName = generateUniqueFileName(sheetName);
    
    // Export the specific sheet to XLSX
    await exportSheetToXLSX(SPREADSHEET_ID, sheetName, uniqueFileName);
    
    // Upload to Drive and get file ID
    const fileId = await uploadXLSXToDrive(uniqueFileName, EXPORT_FOLDER_ID);

    // Clean up the temporary file
    try {
      fs.unlinkSync(uniqueFileName);
      console.log(`✅ Cleaned up temporary file: ${uniqueFileName}`);
    } catch (error) {
      console.error(`❌ Error cleaning up file: ${error.message}`);
    }

    res.status(200).json({
      success: true,
      message: `Sheet "${sheetName}" downloaded successfully`,
      fileId: fileId
    });
  } catch (error) {
    console.error('Error downloading sheet:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to download sheet',
      error: error.message
    });
  }
});

// Add this endpoint to generate related questions
app.post('/generate-questions', async (req, res) => {
  try {
    const { sheetName, generate_prompt } = req.body;
    if (!sheetName) {
      throw new Error('Sheet name is required');
    }

    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [`${sheetName}!A:G`],
      fields: 'sheets.data.rowData.values(formattedValue)'
    });

    const rows = response.data.sheets[0].data[0].rowData || [];
    let processedRows = 1;
    
    for (const rowData of rows.slice(1)) {
      const cells = rowData.values;
      
      // Get raw text without formatting
      const passage = cells[1]?.formattedValue || '';
      const question = cells[2]?.formattedValue || '';
      const answer = cells[3]?.formattedValue || '';
      const passageType = cells[4]?.formattedValue || '';
      const questionType = cells[5]?.formattedValue || '';
      const difficultyLevel = cells[6]?.formattedValue || '';

      // Check for "None" in any of the cells and stop processing if found
      if (passage === "None" || question === "None" || answer === "None" || 
          passageType === "None" || questionType === "None" || difficultyLevel === "None") {
        console.log('Found "None" in row, stopping generation');
        break;
      }

      // Check for the word "Answer" and skip processing if found
      if ([passage, question, answer, passageType, questionType, difficultyLevel].some(field => field.includes("Answer"))) {
        console.log(`Skipping row ${processedRows + 1} due to presence of "Answer"`);
        processedRows++;
        continue;
      }

      if (!passage || !question) {
        console.log('Skipping row due to missing data');
        continue;
      }

      try {
        console.log(`\n🔄 Processing Sheet: ${sheetName} | Row: ${processedRows}`);

        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are an expert SAT question generator. Your task is to create new, engaging questions that match the style and difficulty of the SAT.\n\nKey requirements for your responses:\n1. Use appropriate formatting to enhance readability and emphasis:\n   - Bold (**text**) ONLY when you think it is necessary.\n   - Italics (*text*) ONLY for titles of works, foreign words, or emphasis\n   - Underline ({text}) ONLY when the question asks for it, e.g. "What is the purpose of the underlined section?"\n   - Quotes ("text") for direct quotations\n2. Use proper line breaks:\n   - \\n for single line breaks\n   - \\n\\n for paragraph breaks\n3. If the question involves a graph or visual element, start with %GRAPH%\n4. Maintain consistent difficulty level and question type\n5. Ensure historical/scientific accuracy\n6. Create clear, unambiguous answer choices\n7. A question cannot be formatted twice, e.g. _**text**_ is invalid.\n\nReturn ONLY in this JSON format:\n{\n  "passage": "[formatted passage]",\n  "question": "[formatted question]\\n\\nA) [Option A]\\nB) [Option B]\\nC) [Option C]\\nD) [Option D]\\n\\n",\n  "correct_answer": "[Letter]"\n}`
            },
            {
              role: "user",
              content: `Generate a NEW question that is a variant of the original below — same passage type, question type, and difficulty, but with different content (new passage, new question, new answer choices). Do not copy the original.\n\nPassage type: ${passageType || 'N/A'}\nQuestion type: ${questionType || 'N/A'}\nDifficulty: ${difficultyLevel || 'N/A'}\n\nOriginal passage:\n${passage || 'N/A'}\n\nOriginal question:\n${question || 'N/A'}\n\nOriginal correct answer: ${answer || 'N/A'}${generate_prompt ? `\n\nAdditional instructions: ${generate_prompt}` : ''}`
            }
          ],
        });

        const generatedContent = completion.choices[0]?.message?.content;
        console.log('Raw GPT Response:', generatedContent);

        // Clean and parse the response
        const cleanedContent = cleanJsonResponse(generatedContent);
        // console.log('Cleaned Response:', cleanedContent);

        const generatedQuestion = JSON.parse(cleanedContent);
        console.log('Parsed Question:', generatedQuestion);

        // Append the generated question starting from column N
        const targetRange = `${sheetName}!N${processedRows + 1}`;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: targetRange,
          valueInputOption: 'RAW',
          resource: {
            values: [[generatedQuestion.passage, generatedQuestion.question, generatedQuestion.correct_answer]]
          }
        });
        
        processedRows++;
        console.log(`✅ Generated question for Row ${processedRows} in ${sheetName}`);
      } catch (error) {
        console.error(`❌ Error generating question for Row ${processedRows + 1} in ${sheetName}:`, error);
      }
    }

    res.status(200).json({
      success: true,
      message: `Generated ${processedRows} questions and appended to sheet: ${sheetName}`,
      sheetName,
      processedRows
    });
  } catch (error) {
    console.error('Error generating questions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate questions',
      error: error.message
    });
  }
});

// Add new endpoint to handle payload request
app.post('/regenerate', async (req, res) => {
  try {
    const { sheetName, row, regenerate_prompt } = req.body;
    if (!sheetName || !row) {
      return res.status(400).json({
        success: false,
        message: 'Sheet name and row number are required'
      });
    }

    // Read the row's current question (the content to regenerate) plus its metadata.
    // Columns: D=passage, E=content, F=choice_A, G=choice_B, H=choice_C, I=choice_D,
    // J=correct_answer, K=passage_type, L=question_type, M=question_difficulty.
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [`${sheetName}!D${row}:M${row}`],
      fields: 'sheets.data.rowData.values(effectiveFormat.textFormat,formattedValue)'
    });

    // Extract values and formatting
    const rowData = response.data.sheets[0].data[0].rowData[0];
    const cells = rowData.values;

    // Get formatted text
    const passage = convertFormattingToMarkup(cells[0]);
    const content = convertFormattingToMarkup(cells[1]);
    const choiceA = convertFormattingToMarkup(cells[2]);
    const choiceB = convertFormattingToMarkup(cells[3]);
    const choiceC = convertFormattingToMarkup(cells[4]);
    const choiceD = convertFormattingToMarkup(cells[5]);
    const answer = cells[6]?.formattedValue || '';
    const passageType = convertFormattingToMarkup(cells[7]);
    const questionType = convertFormattingToMarkup(cells[8]);
    const difficultyLevel = convertFormattingToMarkup(cells[9]);

    console.log("Formatted values", passage, content, choiceA, choiceB, choiceC, choiceD, answer, passageType, questionType, difficultyLevel);
    console.log(`\n🔄 Processing Sheet: ${sheetName} | Row: ${row}`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert SAT question generator. Your task is to create new, engaging questions that match the style and difficulty of the SAT.\n\nKey requirements for your responses:\n1. Use appropriate formatting to enhance readability and emphasis:\n   - Bold (**text**) ONLY when you think it is necessary.\n   - Italics (*text*) ONLY for titles of works, foreign words, or emphasis\n   - Underline ({text}) ONLY when the question asks for it, e.g. "What is the purpose of the underlined section?"\n   - Quotes ("text") for direct quotations\n2. Use proper line breaks:\n   - \\n for single line breaks\n   - \\n\\n for paragraph breaks\n3. If the question involves a graph or visual element, start with %GRAPH%\n4. Maintain consistent difficulty level and question type\n5. Ensure historical/scientific accuracy\n6. Create clear, unambiguous answer choices\n7. A question cannot be formatted twice, e.g. _**text**_ is invalid.\n\nReturn ONLY in this JSON format, with each answer choice as its own field (no letter prefixes inside the choices):\n{\n  "passage": "[formatted passage]",\n  "content": "[formatted question stem]",\n  "choice_A": "[Option A]",\n  "choice_B": "[Option B]",\n  "choice_C": "[Option C]",\n  "choice_D": "[Option D]",\n  "correct_answer": "[Letter]"\n}`
        },
        {
          role: "user",
          content: `Generate a NEW question that is a variant of the original below — same passage type, question type, and difficulty, but with different content (new passage, new question, new answer choices). Do not copy the original.\n\nPassage type: ${passageType || 'N/A'}\nQuestion type: ${questionType || 'N/A'}\nDifficulty: ${difficultyLevel || 'N/A'}\n\nOriginal passage:\n${passage || 'N/A'}\n\nOriginal question:\n${content || 'N/A'}\n\nOriginal choices:\nA) ${choiceA || 'N/A'}\nB) ${choiceB || 'N/A'}\nC) ${choiceC || 'N/A'}\nD) ${choiceD || 'N/A'}\n\nOriginal correct answer: ${answer || 'N/A'}${regenerate_prompt ? `\n\nAdditional instructions: ${regenerate_prompt}` : ''}`
        }
      ],
    });

    const generatedContent = completion.choices[0]?.message?.content;

    // Clean and parse the response
    const cleanedContent = cleanJsonResponse(generatedContent);
    const generatedQuestion = JSON.parse(cleanedContent);

    // Overwrite the question in place: D=passage, E=content, F–I=choices, J=correct_answer.
    // Metadata (K–M) is left intact.
    const targetRange = `${sheetName}!D${row}:J${row}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: targetRange,
      valueInputOption: 'RAW',
      resource: {
        values: [[
          generatedQuestion.passage,
          generatedQuestion.content,
          generatedQuestion.choice_A,
          generatedQuestion.choice_B,
          generatedQuestion.choice_C,
          generatedQuestion.choice_D,
          generatedQuestion.correct_answer,
        ]]
      }
    });

    console.log(`✅ Generated question for Row ${row} in ${sheetName}`);

    res.status(200).json({
      success: true,
      message: `Generated question for row ${row} in sheet: ${sheetName}`,
      data: generatedQuestion
    });

  } catch (error) {
    console.error('Error generating similar question:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate similar question',
      error: error.message
    });
  }
});

// Try to resolve a Drive folder's display name. Returns null if the lookup fails
// (e.g. permissions) — the ID is what actually determines "connected".
async function driveName(fileId) {
  if (!fileId) return null;
  try {
    const res = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
    return res.data.name || null;
  } catch (err) {
    console.error(`⚠️ Could not resolve folder name for ${fileId}:`, err.message);
    return null;
  }
}

async function spreadsheetName() {
  if (!SPREADSHEET_ID) return null;
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'properties.title' });
    return res.data.properties?.title || null;
  } catch (err) {
    console.error(`⚠️ Could not resolve spreadsheet name for ${SPREADSHEET_ID}:`, err.message);
    return null;
  }
}

// Connection is determined by whether the ID is configured (same as the
// spreadsheet). Show the resolved name when available, otherwise fall back to the
// ID; null only when no ID is set, so the UI shows "Not connected to any folder".
app.get('/connection-info', async (req, res) => {
  const [imageName, pdfName, sheetTitle] = await Promise.all([
    driveName(FOLDER_ID),
    driveName(FOLDER_PDF),
    spreadsheetName(),
  ]);
  const label = (name, id) => (id ? (name || id) : null);
  const spreadsheet = label(sheetTitle, SPREADSHEET_ID);
  res.json({
    image: label(imageName, FOLDER_ID),
    pdf: label(pdfName, FOLDER_PDF),
    generate: spreadsheet,
    regenerate: spreadsheet,
  });
});

// Return every data row's content for the Regenerate row picker.
// Columns: D=passage, E=content, F–I=choice_A–D, J=correct_answer,
// K=passage_type, L=question_type, M=question_difficulty.
// Row numbers are 1-based and start at 2 (row 1 is the header).
app.get('/sheet-rows', async (req, res) => {
  try {
    const { sheetName } = req.query;
    if (!sheetName) {
      return res.status(400).json({ success: false, message: 'sheetName is required' });
    }
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!D2:M`,
    });
    const rows = (response.data.values || [])
      .map((r, i) => ({
        row: i + 2,
        passage: r[0] || '',
        content: r[1] || '',
        choiceA: r[2] || '',
        choiceB: r[3] || '',
        choiceC: r[4] || '',
        choiceD: r[5] || '',
        answer: r[6] || '',
        passageType: r[7] || '',
        questionType: r[8] || '',
        difficulty: r[9] || '',
      }))
      .filter((x) => x.passage || x.content || x.answer);
    res.json({ success: true, rows });
  } catch (error) {
    console.error('Error reading sheet rows:', error);
    res.status(500).json({ success: false, message: 'Failed to read sheet rows', error: error.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;

// The UI (API_BASE) and the Electron launcher both expect the server on PORT, so
// fail clearly if it's taken rather than silently binding a different port.
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Close whatever is using it (or set PORT) and relaunch.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// Add this function to generate a unique filename
function generateUniqueFileName(sheetName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${sheetName}_${timestamp}.xlsx`;
}

// Add this function to get all sheet names
async function getSheetNames() {
  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets.properties.title'
    });

    const sheetNames = response.data.sheets.map(sheet => sheet.properties.title);
    return sheetNames.reverse(); // Reverse the order
  } catch (error) {
    console.error('Error fetching sheet names:', error);
    throw error;
  }
}

// Add this endpoint
app.get('/sheet-names', async (req, res) => {
  try {
    const sheetNames = await getSheetNames();
    res.json({ success: true, sheetNames });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch sheet names',
      error: error.message 
    });
  }
});