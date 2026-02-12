# Use the Node.js 18 style image
FROM node:18-bullseye-slim

# Install the necessary tools to compile sqlite3 (Python and make)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy dependency files and install them
COPY package.json ./
RUN npm install --production

# Copy the entire project (including app.js and public folder)
COPY . .

# Port 80 is exposed
EXPOSE 80

# Run command
CMD ["node", "app.js"]