FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install && npm install express-rate-limit
COPY *.js .
RUN mkdir -p /app/data && chown -R node:node /app/data
EXPOSE 3001
USER node
CMD ["node", "server.js"]
