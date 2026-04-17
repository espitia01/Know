# Know - Pedagogical Paper Enhancement Platform

Transform academic papers into interactive learning experiences. Upload a PDF, get structured content with LaTeX rendering, and use AI-powered tools to prepare before reading, look up definitions, work through derivations, and more.

## Features

- **PDF Upload & Parsing** - Upload any academic PDF; extracts text, figures, LaTeX math, and references
- **Enhanced Reader** - Markdown rendering with KaTeX math, inline figures, clean typography
- **Pre-Reading Preparation** - AI extracts definitions, research questions, prior work, and key concepts
- **Definition Lookup** - Select any term in the paper to get an AI-powered explanation
- **Interactive Derivations** - Step-by-step exercises with hints and progressive reveals
- **Assumptions Extraction** - Identifies explicit and implicit assumptions
- **Q&A System** - Write questions while reading, get batch answers from AI
- **Full-Text Search** - Search across paper content, definitions, and references
- **Supplementary Information** - Upload SI PDFs linked to the main paper
- **Local Model Support** - Use Anthropic Claude or connect your own local model via Ollama

## Architecture

```
Know/
  frontend/          # Next.js 16 + Tailwind + shadcn/ui
  backend/           # Python FastAPI
  papers/            # Uploaded papers (gitignored)
```

## Quick Start

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Set your API key
export KNOW_ANTHROPIC_API_KEY=sk-ant-...

# Start the server
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Set these environment variables (or create `backend/.env`):

| Variable | Description | Default |
|---|---|---|
| `KNOW_ANTHROPIC_API_KEY` | Anthropic API key for Claude | (empty) |
| `KNOW_LOCAL_MODEL_URL` | OpenAI-compatible API URL | (empty) |
| `KNOW_LOCAL_MODEL_NAME` | Model name for local provider | (empty) |
| `KNOW_ACTIVE_PROVIDER` | `anthropic` or `local` | `anthropic` |

You can also configure these at runtime via the Settings page in the app.

## Tech Stack

**Backend**: FastAPI, PyMuPDF, Anthropic SDK, httpx, Pydantic

**Frontend**: Next.js 16, React, Tailwind CSS, shadcn/ui, react-markdown, remark-math, rehype-katex, Zustand
