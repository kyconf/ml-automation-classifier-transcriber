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

# --- Figure location -------------------------------------------------------
# Graphs and tables are located here so the Node side can crop them out of the
# page. All coordinates are PDF points, top-left origin (pdfplumber convention).

MIN_FIG_WIDTH = 150   # pt — smaller boxes are inline equation snippets, not figures
MIN_FIG_HEIGHT = 60   # pt
FIG_PAD = 4           # pt of breathing room around a crop
GRID_CELL = 4         # pt resolution used when clustering vector art
MIN_STROKE = 20       # pt — shorter primitives are glyph outlines, not chart structure
MAX_FIG_AREA = 0.60   # a block covering more of the page than this is the page frame
GROW_MARGIN = 12      # pt — how far to reach when pulling labels into a chart box
GROW_ITERS = 4        # label rings to walk outward (tick labels, then axis title)
GROW_MAX = 90         # pt — hard cap so growth cannot run into the body text
EDGE_MARGIN = 24      # pt — how close to a page edge counts as running off it


def _box(page, x0, top, x1, bottom, source):
    x0 = max(0.0, x0 - FIG_PAD)
    top = max(0.0, top - FIG_PAD)
    x1 = min(float(page.width), x1 + FIG_PAD)
    bottom = min(float(page.height), bottom + FIG_PAD)
    return {
        'x0': x0, 'top': top, 'x1': x1, 'bottom': bottom,
        'source': source,
        # A figure running into the page edge may be one half of a figure that
        # continues on the neighbouring page.
        'touches_top': top <= EDGE_MARGIN,
        'touches_bottom': bottom >= float(page.height) - EDGE_MARGIN,
    }


def _image_boxes(page):
    """Figures that are embedded raster images — the reliable case."""
    boxes = []
    for im in page.images:
        width = im['x1'] - im['x0']
        height = im['bottom'] - im['top']
        if width >= MIN_FIG_WIDTH and height >= MIN_FIG_HEIGHT:
            boxes.append(_box(page, im['x0'], im['top'], im['x1'], im['bottom'], 'image'))
    return boxes


def _vector_boxes(page):
    """Fallback for charts drawn as line art rather than embedded images.

    Only structural strokes are considered — axes, gridlines, bars, table
    borders. Glyph outlines are skipped, which matters because in these exports
    the body text is itself vector art; clustering everything merges the whole
    page into one block. The survivors are painted onto a coarse grid,
    flood-filled into connected blocks, and kept only if the block looks like a
    chart or table rather than a page frame.
    """
    def keep(p):
        width, height = p['x1'] - p['x0'], p['bottom'] - p['top']
        if width < MIN_STROKE and height < MIN_STROKE:
            return False  # glyph outline
        # Page backgrounds and borders touch everything and would fuse the whole
        # page into a single block, so drop anything page-sized.
        if width >= 0.9 * float(page.width) and height >= 0.9 * float(page.height):
            return False
        return True

    prims = [p for p in (list(page.curves) + list(page.rects) + list(page.lines)) if keep(p)]
    if not prims:
        return []

    cols = int(page.width // GRID_CELL) + 1
    rows = int(page.height // GRID_CELL) + 1
    grid = bytearray(cols * rows)

    for p in prims:
        r0 = max(0, int(p['top'] // GRID_CELL))
        r1 = min(rows - 1, int(p['bottom'] // GRID_CELL))
        c0 = max(0, int(p['x0'] // GRID_CELL))
        c1 = min(cols - 1, int(p['x1'] // GRID_CELL))
        for r in range(r0, r1 + 1):
            base = r * cols
            for c in range(c0, c1 + 1):
                grid[base + c] = 1

    seen = bytearray(cols * rows)
    boxes = []

    for start in range(cols * rows):
        if not grid[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        min_r = max_r = start // cols
        min_c = max_c = start % cols
        while stack:
            idx = stack.pop()
            r, c = divmod(idx, cols)
            if r < min_r: min_r = r
            if r > max_r: max_r = r
            if c < min_c: min_c = c
            if c > max_c: max_c = c
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < rows and 0 <= nc < cols:
                        n = nr * cols + nc
                        if grid[n] and not seen[n]:
                            seen[n] = 1
                            stack.append(n)

        x0, x1 = min_c * GRID_CELL, (max_c + 1) * GRID_CELL
        top, bottom = min_r * GRID_CELL, (max_r + 1) * GRID_CELL
        width, height = x1 - x0, bottom - top
        if width < MIN_FIG_WIDTH or height < MIN_FIG_HEIGHT:
            continue
        if (width * height) > MAX_FIG_AREA * float(page.width) * float(page.height):
            continue  # page border or full-page frame, not a figure

        # Chart/table signature: at least two strokes spanning 60%+ of the block.
        long_strokes = 0
        for p in prims:
            if p['x0'] >= x0 - 1 and p['x1'] <= x1 + 1 and p['top'] >= top - 1 and p['bottom'] <= bottom + 1:
                if (p['x1'] - p['x0']) >= 0.6 * width or (p['bottom'] - p['top']) >= 0.6 * height:
                    long_strokes += 1
                    if long_strokes >= 2:
                        break
        if long_strokes >= 2:
            gx0, gtop, gx1, gbottom = _grow_to_labels(page, x0, top, x1, bottom)
            boxes.append(_box(page, gx0, gtop, gx1, gbottom, 'vector'))

    return boxes


def _grow_to_labels(page, x0, top, x1, bottom):
    """Expand a chart's stroke box outward to take in its labels.

    Clustering runs on structural strokes only, so the resulting box is the plot
    area — axis titles, tick labels, the legend and the caption all sit outside
    it. Walk outward in small steps, absorbing anything close by, so the crop
    picks up the labels but stops at the whitespace before the body text.
    """
    items = list(page.chars) + list(page.curves) + list(page.rects) + list(page.lines)
    ox0, otop, ox1, obottom = x0, top, x1, bottom

    for _ in range(GROW_ITERS):
        grew = False
        for it in items:
            if (it['x1'] < x0 - GROW_MARGIN or it['x0'] > x1 + GROW_MARGIN
                    or it['bottom'] < top - GROW_MARGIN or it['top'] > bottom + GROW_MARGIN):
                continue
            nx0 = max(min(x0, it['x0']), ox0 - GROW_MAX)
            ntop = max(min(top, it['top']), otop - GROW_MAX)
            nx1 = min(max(x1, it['x1']), ox1 + GROW_MAX)
            nbottom = min(max(bottom, it['bottom']), obottom + GROW_MAX)
            if (nx0, ntop, nx1, nbottom) != (x0, top, x1, bottom):
                x0, top, x1, bottom = nx0, ntop, nx1, nbottom
                grew = True
        if not grew:
            break

    return x0, top, x1, bottom


def find_figures(page):
    """Embedded images win; only fall back to vector clustering if there are none."""
    boxes = _image_boxes(page)
    if not boxes:
        boxes = _vector_boxes(page)
    return sorted(boxes, key=lambda b: (b['top'], b['x0']))

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

@app.route('/figures', methods=['POST'])
def figures():
    """Locate graphs/tables on every page of a PDF, in PDF points."""
    try:
        data = request.get_json()
        pdf_path = data.get('pdf_path', '')
        # Optional 1-based page allowlist. Scanning a page is not cheap, so the
        # caller passes only the pages it knows contain a graph.
        wanted = data.get('pages') or None

        if not pdf_path or not os.path.exists(pdf_path):
            return jsonify({'success': False, 'error': f'PDF not found: {pdf_path}'}), 400

        pages = {}
        with pdfplumber.open(pdf_path) as pdf:
            for page_number, page in enumerate(pdf.pages, 1):
                if wanted and page_number not in wanted:
                    continue
                found = find_figures(page)
                if found:
                    pages[str(page_number)] = found

        print(f"Located figures on {len(pages)} page(s) of {os.path.basename(pdf_path)}")
        return jsonify({'success': True, 'pages': pages})

    except Exception as e:
        print(f"Figure detection error: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/stitch', methods=['POST'])
def stitch():
    """Join figure crops vertically — for a figure split across a page break."""
    try:
        data = request.get_json()
        parts = data.get('parts') or []
        out_path = data.get('out_path', '')

        if len(parts) < 2 or not out_path:
            return jsonify({'success': False, 'error': 'Need at least two parts and an out_path'}), 400

        missing = [p for p in parts if not os.path.exists(p)]
        if missing:
            return jsonify({'success': False, 'error': f'Missing crops: {missing}'}), 400

        from PIL import Image
        images = [Image.open(p).convert('RGB') for p in parts]
        width = max(im.width for im in images)
        height = sum(im.height for im in images)

        canvas = Image.new('RGB', (width, height), 'white')
        y = 0
        for im in images:
            canvas.paste(im, ((width - im.width) // 2, y))
            y += im.height
        canvas.save(out_path)

        print(f"Stitched {len(parts)} crops into {os.path.basename(out_path)}")
        return jsonify({'success': True, 'path': out_path})

    except Exception as e:
        print(f"Stitch error: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500

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