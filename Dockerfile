FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

ENV PORT=8899
EXPOSE 8899

CMD ["npm", "run", "wreck:start"]
