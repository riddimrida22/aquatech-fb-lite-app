# Aquatech Invoicing service (cloud). Renders NYCDEP cost-plus invoice packages from
# live AqtPM Postgres data. Uses LibreOffice (headless) for xlsx->PDF, so no Windows/Excel.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    INVOICING_CLOUD=1 \
    PORT=8765 \
    HOME=/tmp

# LibreOffice Calc (headless xlsx->PDF) + fonts for faithful rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-calc \
        fonts-liberation fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/invoicing

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code, generators, templates, assets, ledger, billing-period CSV.
COPY . .

# soffice must be on PATH (it is: /usr/bin/soffice); run the FastAPI app.
WORKDIR /srv/invoicing/app
EXPOSE 8765
CMD ["python", "server.py"]
