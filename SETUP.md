# LoanLens — Setup Guide

## Step 1: Install Node.js
Download and install from: https://nodejs.org (choose "LTS" version)
After installing, restart your terminal/PowerShell.

## Step 2: Add your Anthropic API Key
Copy the example env file and add your key:
```
copy .env.example .env
```
Then open `.env` and replace `your_api_key_here` with your actual key from https://console.anthropic.com

## Step 3: Install dependencies
Open PowerShell in the `loan-analyzer` folder and run:
```
npm install
```

## Step 4: Start the app
```
npm start
```

Then open your browser at: http://localhost:3000

## That's it!
Upload any home loan PDF and the app will:
- Score it out of 100 across 5 dimensions
- Flag high-risk clauses
- Explain everything in plain English
- Let you ask questions by voice or text
