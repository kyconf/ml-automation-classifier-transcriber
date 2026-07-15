from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
import torch
import pdfplumber
from werkzeug.utils import secure_filename
import os
import sys
import tempfile

app = Flask(__name__, static_folder='./project_backup')  # Set the current directory as static folder
CORS(app, resources={r"/*": {"origins": "*"}})  # Allow all origins for development

# Resolve bundled data. When packaged by PyInstaller, files added via --add-data
# live under sys._MEIPASS; in normal runs they sit next to this script.
BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))

# Load the fine-tuned model and tokenizer
model_path = os.path.join(BASE_DIR, "project_backup", "fine_tuned_model")
try:
    model = AutoModelForSeq2SeqLM.from_pretrained(model_path)
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    if torch.cuda.is_available():
        model = model.cuda()
    print("Model and tokenizer loaded successfully")
except Exception as e:
    print(f"Error loading model: {str(e)}")

# Add these routes to app.py
# Use a writable temp dir — the app bundle's own folder is read-only once installed.
UPLOAD_FOLDER = os.path.join(tempfile.gettempdir(), 'exam_transcriber_uploads')
ALLOWED_EXTENSIONS = {'pdf'}

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_text_from_pdf(pdf_path):
    try:
        text = ""
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                extracted = page.extract_text()
                if extracted:
                    text += extracted + "\n"
        
        # Debug print
        print("Extracted text:", text[:200])  # Print first 200 chars
        
        if not text.strip():
            return "Error: No text could be extracted from PDF"
            
        return text.strip()
    except Exception as e:
        print(f"PDF extraction error: {str(e)}")
        return f"Error extracting PDF: {str(e)}"

def get_cell_formatting(cell):
    """Extract detailed formatting information from a cell"""
    if not cell:
        return {}
    
    formatting = {}
    
    # Font properties
    if cell.font:
        formatting['font'] = {
            'name': cell.font.name,
            'size': cell.font.size,
            'bold': cell.font.bold,
            'italic': cell.font.italic,
            'underline': cell.font.underline,
            'strike': cell.font.strike,
            'color': cell.font.color.rgb if cell.font.color else None
        }
    
    # Alignment
    if cell.alignment:
        formatting['alignment'] = {
            'horizontal': cell.alignment.horizontal,
            'vertical': cell.alignment.vertical,
            'wrap_text': cell.alignment.wrap_text
        }
    
    # Fill/background
    if cell.fill:
        formatting['fill'] = {
            'type': cell.fill.fill_type,
            'start_color': cell.fill.start_color.rgb if cell.fill.start_color else None,
            'end_color': cell.fill.end_color.rgb if cell.fill.end_color else None
        }
    
    return formatting

def classify_question(question_text):
    # COPY EXACTLY FROM flant5modeltest.py
    # Add a prefix to make it clear we want classification
    input_text = f"Classify: {question_text}"
    
    # Tokenize input
    inputs = tokenizer(
        input_text,
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="pt"
    )
    
    # Generate prediction
    outputs = model.generate(
        input_ids=inputs["input_ids"],
        attention_mask=inputs["attention_mask"],
        max_length=128,
        num_beams=4,
        early_stopping=True,
        do_sample=False
    )
    
    # Decode prediction
    prediction = tokenizer.decode(outputs[0], skip_special_tokens=True)
    return prediction

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/classify', methods=['POST'])
def classify():
    try:
        data = request.get_json()
        question_text = data.get('question', '')
        
        # Get model prediction first
        input_text = f"Classify: {question_text}"
        inputs = tokenizer(input_text, return_tensors="pt", max_length=512, truncation=True)
        if torch.cuda.is_available():
            inputs = {k: v.cuda() for k, v in inputs.items()}
        
        outputs = model.generate(**inputs, max_length=128)
        prediction = tokenizer.decode(outputs[0], skip_special_tokens=True)

        # Check for Rhetorical Synthesis patterns
        if (
            "While researching a topic" in question_text or
            "to accomplish this goal" in question_text or
            "to accomplish these goals" in question_text or
            "Which choice most effectively uses information from the given sentences" in question_text
        ):
            # Only force the Question Type, keep other predictions
            parts = prediction.split('|')
            forced_prediction = f"{parts[0]} | Question Type: Rhetorical Synthesis | {parts[2]}"
            return jsonify({
                'success': True,
                'classification': forced_prediction,
                'forced': True
            })
        
        return jsonify({
            'success': True,
            'classification': prediction,
            'forced': False
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.get_json()
        question = data['question']
        
        # First check for Rhetorical Synthesis patterns
        if (
            "While researching a topic" in question or
            "to accomplish this goal" in question or
            "to accomplish these goals" in question or
            "Which choice most effectively uses information from the given sentences" in question
        ):
            # Force Rhetorical Synthesis classification
            return jsonify({
                'prediction': 'Passage Type: Natural Science | Question Type: Rhetorical Synthesis | Question Difficulty: Medium',
                'forced': True
            })
        
        # Otherwise use model prediction
        input_text = f"Classify: {question}"
        inputs = tokenizer(input_text, return_tensors="pt", max_length=512, truncation=True)
        
        if torch.cuda.is_available():
            inputs = {k: v.cuda() for k, v in inputs.items()}
            
        outputs = model.generate(**inputs, max_length=128)
        prediction = tokenizer.decode(outputs[0], skip_special_tokens=True)
        
        return jsonify({
            'prediction': prediction,
            'forced': False
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/upload_pdf', methods=['POST'])
def upload_pdf():
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file part'}), 400
            
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
            
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(filepath)
            
            # Extract text from PDF
            question_text = extract_text_from_pdf(filepath)
            print("Extracted text:", question_text)  # Debug print
            
            # Clean up the file after extraction
            os.remove(filepath)
            
            # For testing, return dummy classification
            return jsonify({
                'success': True,
                'classification': 'Passage Type: Test | Question Type: Test | Question Difficulty: Test',
                'text': question_text
            })
            
    except Exception as e:
        print(f"Upload error: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    try:
        print("Starting server...")
        app.run(debug=False, port=5001)  # Back to port 5000
    except Exception as e:
        print(f"Error starting server: {str(e)}")