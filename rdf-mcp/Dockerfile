FROM node:20-alpine
WORKDIR /app

# Copia package.json e installa dipendenze
COPY package.json .
RUN npm install --production

# Copia server
COPY server.js .

# worker.js viene scaricato all'avvio se non esiste
# (oppure montato come volume per sviluppo locale)

EXPOSE 3003
CMD ["node", "server.js"]
