# Minimal LLM Gateway Dockerfile
# Lean Node 20 Alpine Linux image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies (only production packages)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code and migrations
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose default HTTP port
EXPOSE 3000

# Run database migrations and launch server
CMD ["sh", "-c", "node src/db/migrate.js && node src/server.js"]
