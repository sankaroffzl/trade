FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY qx-signal-lite.mjs ./
COPY .env.example ./
CMD ["node", "qx-signal-lite.mjs"]
