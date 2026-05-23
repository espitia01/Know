-- 020_ocr_markdown.sql — Mistral OCR markdown reader fields

ALTER TABLE papers
  ADD COLUMN IF NOT EXISTS markdown      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS page_markdown JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS ocr_images    JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS ocr_status    TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS ocr_model     TEXT NOT NULL DEFAULT '';
