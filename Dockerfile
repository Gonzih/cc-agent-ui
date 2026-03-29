FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build 2>/dev/null || true
EXPOSE 7701
ENV PORT=7701
CMD ["node", "server.js"]
