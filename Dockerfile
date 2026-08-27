# Imagen oficial de Playwright: ya trae Chromium + Firefox + WebKit
# y todas las librerías de sistema necesarias preinstaladas.
# Ajusta la versión si cambias la de "playwright" en package.json.
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

COPY package*.json ./
# Evitamos que el postinstall vuelva a descargar el navegador:
# la imagen base ya lo trae.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
