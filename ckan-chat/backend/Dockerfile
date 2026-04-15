FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install && npm install express-rate-limit
COPY *.js .
EXPOSE 3001
USER node
CMD ["node", "server.js"]
