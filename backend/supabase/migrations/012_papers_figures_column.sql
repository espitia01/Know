-- 012_papers_figures_column.sql
--
-- Persist extracted figure metadata with the paper row.
--
-- PDFs and rendered figure PNGs are already mirrored to Supabase Storage, but
-- the FigureInfo metadata (id, caption, page) previously lived only in
-- paper.json on the Railway container filesystem. On redeploy / worker churn
-- that local file can disappear, and the Supabase rebuild path produced
-- ParsedPaper(figures=[]), forcing users to re-extract figures every time.

ALTER TABLE papers
    ADD COLUMN IF NOT EXISTS figures JSONB NOT NULL DEFAULT '[]'::jsonb;

