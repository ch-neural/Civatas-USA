FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY . .

CMD ["npm", "run", "dev"]
