#!/bin/bash

echo "🚀 Starting installation script..."

# Ensure the script is running with admin rights if needed
if [[ "$EUID" -ne 0 ]]; then
    echo "⚠️ Warning: You are not running as root. Some installations might require sudo."
fi

# Ensure Homebrew is available
if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew not found. Install it from https://brew.sh first."
    exit 1
fi

# Update package managers
echo "🔄 Updating Homebrew..."
brew update

# Install Homebrew dependencies
echo "🍺 Installing dependencies via Homebrew..."
brew install libtiff poppler cairo jpeg

# Install specific Python version (3.11)
echo "🐍 Installing Python 3.11..."
brew install python@3.11

# Let Homebrew manage linking (works on both Apple Silicon and Intel).
brew link --overwrite python@3.11 2>/dev/null || true
PYTHON_PATH="$(brew --prefix python@3.11)/bin/python3.11"
if [ -f "$PYTHON_PATH" ]; then
    echo "✅ Python 3.11 installed at $PYTHON_PATH"
else
    echo "❌ Failed to install Python 3.11!"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "⚠️ Node.js is not installed! Installing..."
    brew install node
else
    echo "✅ Node.js is already installed: $(node -v)"
fi

# Install Node.js dependencies
echo "📦 Installing npm packages..."
npm install

# Install Python dependencies
if [ -f "requirements.txt" ]; then
    echo "🐍 Installing Python packages from requirements.txt..."
    $PYTHON_PATH -m pip install -r requirements.txt
else
    echo "⚠️ requirements.txt not found. Skipping Python package installation."
fi


echo "✅ Installation complete!"
