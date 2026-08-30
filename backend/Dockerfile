FROM python:3.13-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ca-certificates \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf-2.0-0 \
    shared-mime-info \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Tectonic compiles LaTeX article + Beamer exports without a full TeX Live image.
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
         amd64) TARCH=x86_64-unknown-linux-gnu ;; \
         arm64) TARCH=aarch64-unknown-linux-gnu ;; \
         *) echo "unsupported arch $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-${TARCH}.tar.gz" \
       | tar -xz -C /usr/local/bin

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data/papers \
    && groupadd -r appuser && useradd -r -g appuser appuser \
    && mkdir -p /tmp/texwarm \
    && printf '%s\n' '\documentclass{article}\begin{document}ok\end{document}' > /tmp/texwarm/a.tex \
    && printf '%s\n' '\documentclass{beamer}\begin{document}\begin{frame}ok\end{frame}\end{document}' > /tmp/texwarm/b.tex \
    && tectonic /tmp/texwarm/a.tex \
    && tectonic /tmp/texwarm/b.tex \
    && mkdir -p /home/appuser/.cache \
    && if [ -d /root/.cache/Tectonic ]; then cp -a /root/.cache/Tectonic /home/appuser/.cache/; fi \
    && chown -R appuser:appuser /data/papers /app /home/appuser

USER appuser

ENV KNOW_PAPERS_DIR=/data/papers

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}"]
