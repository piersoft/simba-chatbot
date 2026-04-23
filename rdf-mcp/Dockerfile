FROM node:20-alpine
WORKDIR /app

# Copia package.json e installa dipendenze
COPY package.json .
RUN npm install --production

# Copia server e worker
COPY server.js .
COPY worker.js .

# worker.js è incluso nella repo con fix per normalizeTTL
# Il server scaricherà aggiornamenti notturni ma il fix viene riapplicato

EXPOSE 3003
CMD ["node", "server.js"]
