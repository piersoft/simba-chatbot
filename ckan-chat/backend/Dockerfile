FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install && npm install express-rate-limit
COPY server.js .
EXPOSE 3001
USER node
CMD ["node", "server.js"]
