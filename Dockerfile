FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package*.json ./

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

COPY server.js .
COPY public/ ./public/

EXPOSE 3001
CMD ["node", "server.js"]
