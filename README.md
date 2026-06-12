ml-automation-classifier-transcriber

An automated pipeline that optimizes the exam creation process by transcribing, parsing, and classifying multi-format exam questions, then exporting them to a structured database.

Goal: Reduces manual exam creation time by 97%, turning a 3-hour manual teaching assistant (TA) workflow into an automated process completed in under 5 minutes. (which it did.)

How it works:
The user uploads a PDF exam through the React web interface. The JavaScript backend handles file processing, text extraction, and image handling. 

A Python service routes the extracted questions through a fine-tuned FLAN-T5 model. The model analyzes the context to output structured metadata labels. 
Then, it classifies the extracted data into different categories according to difficulty, question type, and passage type.

The parsed text and corresponding AI classifications are pushed seamlessly to Google Sheets using the Google Drive and Sheets APIs.


Production & Deployment
Cross-Platform Desktop App: The entire application is packaged using Electron, distributing native desktop binaries for both macOS and Windows users to streamline local deployment and enhance the TA workflow.

HOW TO RUN:

Generate your own Google Cloud credentials, this includes: 
- Google Drive
- Google Sheets

Configure your drive destination folder, and your .env file to contain its respective folder and sheet IDs.
IMPORTANT: API KEY

Do not forget to add to your .gitignore. 
Also, do not forget the Google Sheets Developer Script
(also add the credentials service email to each of your APIs)

