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
import express, { response } from 'express';
import cors from 'cors';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: path.join(__dirname, '.env') });
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
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'sheets_credentials.json'); // Path to your service account key file
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // Replace with your spreadsheet ID

const EXPORT_FOLDER_ID = process.env.EXPORT_FOLDER_ID;

// Authenticate with Google Sheets
const auth = new google.auth.GoogleAuth({   
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const DRIVE_CREDENTIALS_PATH = path.join(__dirname, 'drive_credentials.json');
const DRIVE_TOKEN_PATH = path.join(__dirname, 'drive_token.json');

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
    const existing = JSON.parse(fs.readFileSync(DRIVE_TOKEN_PATH));
    fs.writeFileSync(DRIVE_TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
    console.log('🔄 Drive token refreshed and saved.');
  });
  return oauth2Client;
}

const drive = google.drive({ version: 'v3', auth: getDriveOAuth2Client() });

const FOLDER_ID = process.env.FOLDER_ID;
const FOLDER_PDF = process.env.FOLDER_PDF;

// Define a persistent output directory
const isPackaged = process.env.ELECTRON_IS_PACKAGED === 'true';
const OUTPUT_DIR = isPackaged
  ? path.join(process.env.APPDATA || process.env.HOME, "pdf-transcriber", "converted_images")
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
      const files = fs.readdirSync(OUTPUT_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(OUTPUT_DIR, file));
        console.log(`✅ Deleted: ${file}`);
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

async function appendToSheet(values, sheetName) {
  if (!sheetName) {
    console.error('Sheet name is undefined. Please provide a valid sheet name.');
    return;
  }

  try {
    // Find the actual next empty row in column C
    const colCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!C:C`,
    });
    const existingRows = colCheck.data.values || [];
    const nextRow = Math.max(2, existingRows.length + 1);

    const targetRange = `${sheetName}!C${nextRow}`;

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

// Parse question blob into stem + individual choices
function parseQuestion(questionString) {
  if (!questionString) return { stem: '', choiceA: '', choiceB: '', choiceC: '', choiceD: '' };

  // Split on the first "\n\nA)" to separate stem from choices
  const splitPoint = questionString.search(/\n\nA\)/);
  const stem = splitPoint !== -1 ? questionString.slice(0, splitPoint).trim() : questionString.trim();
  const choicesPart = splitPoint !== -1 ? questionString.slice(splitPoint) : '';

  const matchA = choicesPart.match(/A\)(.*?)(?=\nB\))/s);
  const matchB = choicesPart.match(/B\)(.*?)(?=\nC\))/s);
  const matchC = choicesPart.match(/C\)(.*?)(?=\nD\))/s);
  const matchD = choicesPart.match(/D\)(.*?)(?=\n\n|$)/s);

  return {
    stem,
    choiceA: matchA ? matchA[1].trim() : '',
    choiceB: matchB ? matchB[1].trim() : '',
    choiceC: matchC ? matchC[1].trim() : '',
    choiceD: matchD ? matchD[1].trim() : '',
  };
}

// Add this helper function at the top
function cleanJsonResponse(response) {
  // Remove markdown code blocks and clean the response
  return response.replace(/```json\s*|\s*```/g, '').trim();
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

// Convert PDF to Images
async function convertPdfToImages(pdfPath, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Use the ARM homebrew pdftocairo instead of the bundled x86_64 binary
  const pdftocairo = '/opt/homebrew/bin/pdftocairo';
  const outPrefix = path.join(outputDir, 'page');
  const cmd = `"${pdftocairo}" -png -r 150 "${pdfPath}" "${outPrefix}"`;

  try {
    console.log(`Converting PDF: ${pdfPath} to images...`);
    await execAsync(cmd);

    let images = fs.readdirSync(outputDir)
      .filter((file) => file.endsWith(".png"))
      .sort();

    images = images.slice(0, 54);

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

async function processPdfAndUpload() {
  try {
    await clearProcessingQueue();

    const pdfFiles = await listPdfFilesInFolder(FOLDER_PDF);
    pdfFiles.sort((a, b) => a.name.localeCompare(b.name));

    for (const pdfFile of pdfFiles) {
      console.log(`Processing PDF file: ${pdfFile.name} (${pdfFile.id})`);

      // Get the filename without the .pdf extension
      const sheetName = pdfFile.name.replace('.pdf', '');
      const newSheetName = await createDefaultSheet(SPREADSHEET_ID, sheetName);

      const pdfFilePath = await downloadPdfFromDrive(pdfFile.id);
      const images = await convertPdfToImages(pdfFilePath, OUTPUT_DIR);
    
    for (const image of images) {
      await uploadFileToDrive(image);
    }

      console.log(`✅ All images from ${pdfFile.name} uploaded to Google Drive.`);

      await transcribeImages(images, newSheetName);
    }

    await listFilesInFolder(FOLDER_PDF);
  } catch (error) {
    // Throw the error to be caught by the endpoint
    throw error;
  }
}

// Function to transcribe images
async function transcribeImages(images, sheetName) {
  const responses = [];

  for (const image of images) {
    console.log(`Transcribing image: ${image}`);

    try {
      const base64Image = fs.readFileSync(image, { encoding: 'base64' });

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You are an assistant that transcribes passages and questions from a given image. You must be clear and concise. Do not give any introduction messages like 'Sure, here are the questions'.
                  You are to return it in valid JSON format like the following. Carefully analyze the photo and encapsulate accordingly. Do not confuse "  with each other. There can be multiple in one question. If there are any line breaks, use
                  \\n for single line breaks and \\n\\n for double line breaks. If there is a graph, write %GRAPH% at the beginning of the question. If there are any italics, use *text*. If there are any quotes, use "text". STRICTLY FOLLOW: If there are any underlines, use {text}.
                  For the "section" field: determine whether this is a "Reading and Writing" or "Math" question. Reading and Writing questions have passages, literary texts, or are mostly text-based. Math questions involve equations, numbers, graphs, or mathematical reasoning.
                  {
                  "section": "[Reading and Writing or Math]",
                  "passage": "[passage]",
                  "question": "[question]\\n\\nA) [Option A]\\nB) [Option B]\\nC) [Option C]\\nD) [Option D]\\n\\n",
                  "correct_answer": "[Letter]"
                  }
                `,
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        store: true,
      });

      let newMessage = response.choices[0]?.message?.content || 'No message returned';
      console.log("Raw GPT Response:", newMessage);

      let parseMessage;
      try {
        if (typeof newMessage === 'string') {
          // Clean the JSON response before parsing
          newMessage = cleanJsonResponse(newMessage);
          parseMessage = JSON.parse(newMessage);
        }

        console.log("Parsed Message:", newMessage);
        console.log("RAW QUESTION:", JSON.stringify(parseMessage.question));
        const { stem, choiceA, choiceB, choiceC, choiceD } = parseQuestion(parseMessage.question);
        const valuesToAppend = [[parseMessage.section || '', parseMessage.passage, stem, choiceA, choiceB, choiceC, choiceD, parseMessage.correct_answer]];

        await appendToSheet(valuesToAppend, sheetName);

        console.log(`Response for image appended to Google Sheets!`);
        responses.push({
          image: image,
          response: parseMessage,
        });
      } catch (error) {
        console.error(`Error parsing response for image:`, error.message);
        responses.push({
          image: image,
          error: "Failed to parse OpenAI response",
        });
      }
    } catch (error) {
      console.error(`Error processing image:`, error.message);
      responses.push({
        image: image,
        error: error.message,
      });
    }
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

app.post('/process-pdf', async (req, res) => {
  try {
    await processPdfAndUpload();
    res.status(200).json({
    success: true,  
      message: 'All PDFs have been processed successfully.',
  });
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
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

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

    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row) continue;

      if (!row[2] && !row[3] && !row[4]) continue; // Skip if C, D, E are all empty

      // C=section, D=passage, E=stem, F=choiceA, G=choiceB, H=choiceC, I=choiceD, J=answer
      // Reconstruct with A) B) C) D) labels to match model training format
      const choicesText = [
        row[6] ? `A) ${row[6]}` : '',
        row[7] ? `B) ${row[7]}` : '',
        row[8] ? `C) ${row[8]}` : '',
        row[9] ? `D) ${row[9]}` : '',
      ].filter(p => p).join('\n');

      const question = `${row[3] || ''}\n\n${row[4] || ''}\n\n${choicesText}`.trim();

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
              content: generate_prompt || "Generate a new question following the system instructions."
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

        // Append the generated question starting from column H
        const targetRange = `${sheetName}!H${processedRows + 1}`;
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

    // Read the original sheet data
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [`${sheetName}!B${row}:G${row}`],
      fields: 'sheets.data.rowData.values(effectiveFormat.textFormat,formattedValue)'
    });

    // Extract values and formatting
    const rowData = response.data.sheets[0].data[0].rowData[0];
    const cells = rowData.values;

    // Get formatted text
    const passage = convertFormattingToMarkup(cells[0]);
    const question = convertFormattingToMarkup(cells[1]);
    const answer = cells[2]?.formattedValue || '';
    const passageType = convertFormattingToMarkup(cells[3]);
    const questionType = convertFormattingToMarkup(cells[4]);
    const difficultyLevel = convertFormattingToMarkup(cells[5]);

    console.log("Formatted values", passage, question, answer, passageType, questionType, difficultyLevel);
    console.log(`\n🔄 Processing Sheet: ${sheetName} | Row: ${row}`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert SAT question generator. Your task is to create new, engaging questions that match the style and difficulty of the SAT.\n\nKey requirements for your responses:\n1. Use appropriate formatting to enhance readability and emphasis:\n   - Bold (**text**) ONLY when you think it is necessary.\n   - Italics (*text*) ONLY for titles of works, foreign words, or emphasis\n   - Underline ({text}) ONLY when the question asks for it, e.g. "What is the purpose of the underlined section?"\n   - Quotes ("text") for direct quotations\n2. Use proper line breaks:\n   - \\n for single line breaks\n   - \\n\\n for paragraph breaks\n3. If the question involves a graph or visual element, start with %GRAPH%\n4. Maintain consistent difficulty level and question type\n5. Ensure historical/scientific accuracy\n6. Create clear, unambiguous answer choices\n7. A question cannot be formatted twice, e.g. _**text**_ is invalid.\n\nReturn ONLY in this JSON format:\n{\n  "passage": "[formatted passage]",\n  "question": "[formatted question]\\n\\nA) [Option A]\\nB) [Option B]\\nC) [Option C]\\nD) [Option D]\\n\\n",\n  "correct_answer": "[Letter]"\n}`
        },
        {
          role: "user",
          content: regenerate_prompt || "Generate a new question following the system instructions."
        }
      ],
    });

    const generatedContent = completion.choices[0]?.message?.content;

    // Clean and parse the response
    const cleanedContent = cleanJsonResponse(generatedContent);
    const generatedQuestion = JSON.parse(cleanedContent);

    // Append the generated question starting from column H
    const targetRange = `${sheetName}!H${row}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: targetRange,
      valueInputOption: 'RAW',
      resource: {
        values: [[generatedQuestion.passage, generatedQuestion.question, generatedQuestion.correct_answer]]
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

const PORT = process.env.PORT || 3000; 

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is busy, trying ${PORT + 1}...`);
    app.listen(PORT + 1);
  } else {
    console.error('Server error:', err);
  }
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