# 👻 GhostOps | Enterprise Visual RPA & UI Navigator

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Puppeteer](https://img.shields.io/badge/Puppeteer-40B5A4?style=for-the-badge&logo=puppeteer&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Gemini_2.5_Flash-8E75B2?style=for-the-badge&logo=googlebard&logoColor=white)
![Google Cloud](https://img.shields.io/badge/Google_Cloud-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white)

**GhostOps** is a Large Action Model (LAM) built for the **Google Gemini Live Agent Challenge (UI Navigator Track)**. 

It solves the enterprise "Swivel-Chair" bottleneck by giving AI "Eyes and Hands." Instead of relying on brittle HTML DOM scraping or waiting months for IT to build APIs, GhostOps uses spatial vision to look at legacy software screens, find the exact pixel coordinates of buttons, and autonomously click, type, and navigate on behalf of a human operator.

## ✨ Key Features

*   **🎙️ Voice-Activated Mission Control:** A real-time, WebSocket-powered React/Tailwind dashboard that transcribes voice commands and streams the AI's "thought process" and live vision feed back to the user.
*   **🎯 Set-of-Mark (SoM) Spatial Vision:** Injects high-contrast, numbered bounding boxes over interactive UI elements before passing screenshots to Gemini 2.5 Flash, ensuring 100% mathematical click accuracy.
*   **🔄 Stateful Batch Processing:** Capable of processing entire queues of tasks (e.g., updating 5 different CRM tickets) in a single, persistent browser session without losing DOM state.
*   **☁️ Enterprise Audit Trails:** Upon successful completion of a task, GhostOps captures a clean screenshot and JSON action log, securely uploading it to **Google Cloud Storage (GCS)** for compliance tracking.

---

## 🏗️ Technical Architecture

1.  **Orchestrator (`server.js`):** An Express & WebSocket server that receives voice commands from the frontend, manages the batch processing loop, and streams telemetry.
2.  **The Engine (`ghostops.js`):** Controls the Puppeteer browser. It executes a `while` loop: *Inject Tags -> Screenshot -> Gemini JSON Decision -> Execute Action (Click/Type) -> Repeat until 'done'.*
3.  **The LLM:** `gemini-2.5-flash` natively processes the annotated screenshots and returns strict JSON coordinates/actions using a robust Regex extraction pipeline to prevent "chatty AI" crashes.

---

## 🚀 Installation & Setup

### Prerequisites
*   [Node.js](https://nodejs.org/) (v18 or higher)
*   A Google AI Studio API Key (Gemini)
*   A Google Cloud Platform (GCP) Account with a Storage Bucket

### 1. Clone the Repository
```bash
git clone https://github.com/nilesh-llm/GhostOps-Enterprise-UI-Navigator-LAM
cd GhostOps
npm install
```

### 2. Environment Variables
Create a `.env` file in the root directory. If you already keep secrets in `./.gitignore/.env`, the app now supports that too, but a root `.env` is the cleaner layout.
Start from [`.env.example`](/Users/nileshk/Downloads/GhostOps/.env.example).

```bash
# Gemini API
GEMINI_API_KEY="your_gemini_api_key_here"

# Google Cloud Storage (For Audit Trails)
GCP_PROJECT_ID="ghostops-hackathon"
GCS_BUCKET_NAME="your_bucket_name_here"
GOOGLE_APPLICATION_CREDENTIALS="./.gitignore/google-credentials.json"

# Optional
TARGET_HTML="enterprise-dashboard.html"
PORT="4000"
HOST="127.0.0.1"
```

### 3. Google Cloud Authentication
Generate a Service Account JSON key from your GCP Console with Storage Object Admin permissions.
Save the file as `./.gitignore/google-credentials.json` or point `GOOGLE_APPLICATION_CREDENTIALS` at the correct path.

🎮 Running the Demo
For this demonstration, GhostOps is targeted at a local HTML file (enterprise-dashboard.html) to simulate a locked-down, API-less legacy BPO CRM.

Start the Mission Control Server:
```bash
node server.js
```

Open the Dashboard: Navigate to `http://127.0.0.1:4000` in Google Chrome.
Execute a Command: Click the Microphone button and speak:

"GhostOps, process the backlog."

Watch the Magic: Puppeteer will launch, navigate the local CRM, update 5 distinct support tickets with custom remarks, and upload the final audit logs to your GCP Bucket automatically.


📜 License
Built for the 2026 Google Gemini Hackathon. Open-sourced under the MIT License.
