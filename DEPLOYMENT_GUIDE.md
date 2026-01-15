# Zigma Backend Deployment Guide - EC2 Setup

Complete guide to deploy Zigma backend on a new EC2 instance with PM2, Nginx, and SSL for `api.zigma.pro`

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [EC2 Instance Creation](#ec2-instance-creation)
3. [Initial Server Setup](#initial-server-setup)
4. [Install Dependencies](#install-dependencies)
5. [Deploy Application](#deploy-application)
6. [Configure PM2](#configure-pm2)
7. [Configure Nginx Reverse Proxy](#configure-nginx-reverse-proxy)
8. [Setup SSL Certificate](#setup-ssl-certificate)
9. [Security Hardening](#security-hardening)
10. [Monitoring & Maintenance](#monitoring--maintenance)

---

## Prerequisites

- AWS Account with EC2 access
- Domain `api.zigma.pro` configured in Route 53 or your DNS provider
- SSH client (PuTTY for Windows, Terminal for Mac/Linux)
- Git access to the Zigmav2 repository

---

## EC2 Instance Creation

### 1. Launch EC2 Instance

1. Log in to AWS Console → EC2 Dashboard
2. Click **"Launch Instance"**
3. Configure instance:
   - **Name**: `zigma-backend-prod`
   - **AMI**: Ubuntu Server 22.04 LTS (HVM), SSD Volume Type
   - **Instance Type**: `t3.medium` (2 vCPU, 4 GB RAM) - Minimum recommended
   - **Key Pair**: Create or select existing SSH key pair
   - **Network Settings**:
     - VPC: Default
     - Subnet: Default
     - Auto-assign Public IP: Enable
     - Security Group: Create new (see below)
4. **Storage**: 20 GB GP3 (General Purpose SSD)
5. Click **"Launch Instance"**

### 2. Configure Security Group

Create security group with these inbound rules:

| Type | Protocol | Port Range | Source | Description |
|------|----------|------------|--------|-------------|
| SSH | TCP | 22 | Your IP/0.0.0.0/0 | SSH access |
| HTTP | TCP | 80 | 0.0.0.0/0 | HTTP (for SSL cert) |
| HTTPS | TCP | 443 | 0.0.0.0/0 | HTTPS |
| Custom TCP | TCP | 3001 | 127.0.0.1 | App server (local only) |

### 3. Allocate Elastic IP (Recommended)

1. EC2 → Elastic IPs → Allocate Elastic IP address
2. Associate with your instance
3. Update DNS: Point `api.zigma.pro` to this Elastic IP

---

## Initial Server Setup

### 1. Connect to EC2 Instance

```bash
# On Mac/Linux
ssh -i /path/to/your-key.pem ubuntu@<EC2-PUBLIC-IP>

# On Windows (using PuTTY)
# Load your .pem key in PuTTYgen → Save private key as .ppk
# Connect with PuTTY using ubuntu@<EC2-PUBLIC-IP>
```

### 2. Update System

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git unzip build-essential
```

### 3. Create Application User

```bash
# Create dedicated user for the app
sudo adduser zigma
sudo usermod -aG sudo zigma

# Switch to zigma user
su - zigma
```

---

## Install Dependencies

### 1. Install Node.js 20.x

```bash
# Install Node.js 20.x using NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version  # Should output v20.x.x
npm --version   # Should output 10.x.x
```

### 2. Install PM2 Globally

```bash
sudo npm install -g pm2
pm2 --version
```

### 3. Install Nginx

```bash
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 4. Configure Firewall (UFW)

```bash
# Configure UFW
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

---

## Deploy Application

### 1. Clone Repository

```bash
# Navigate to home directory
cd ~

# Clone the repository
git clone <YOUR-REPO-URL> zigma-backend
cd zigma-backend
```

### 2. Install Dependencies

```bash
npm install --production
```

### 3. Configure Environment Variables

```bash
# Create .env file from example or manually
nano .env
```

Add your environment variables (use values from your previous `.env`):

```env
# Supabase
SUPABASE_URL=https://cysuydnmbstaolswkyha.supabase.co
SUPABASE_ANON_KEY=sb_publishable_hbFUSlwF1QpgRPIouggaFg_qPxyC8Uw

# LLM / xAI (for Grok-mini)
XAI_API_KEY=xai-zPpTxgr8gHAGBUH4PM9bJYmgJpvt2Shahp1BRFQNlf22GQ5Etgx2556A7i0nQA6xTM00qfXlhm4doQCl

USE_MOCK_LLM=false
LLM_PROVIDER=openai
OPENAI_API_KEY=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

# Polymarket
GAMMA_API_URL=https://gamma-api.polymarket.com
GAMMA_LIMIT=500

# Tavily Search
TAVILY_API_KEY=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

# X (Twitter)
X_API_KEY=x4TOHUv3BmegUJTgqDaBoavcG
X_API_SECRET=eJLTMhBxFLnDi0aVYQmbGj5KGcklIBg9mU7rOph5O5qgDcdfGY
X_BEARER_TOKEN=AAAAAAAAAAAAAAAAAAAAAPC4vQEAAAAAePXDX9IdwIyfzyKCVXlT4E0CJDc%3DQ2H0697fQAzmyxy8DG5zUbADhzGs3p1jHlbQtFRvfWuGvjTWnY
X_ACCESS_TOKEN=1609214486933635073-XyUpYtcqp0RjpDqSx0Zd5h83hSeonU
X_ACCESS_SECRET=9vk7fYGUPCZCjV7N8WECAGeMxAjZxdLYLWJE0kPdVRBg5
X_USERNAME=@binarybodhi

# Virtuals / ACP
VIRTUALS_API_KEY=apt-9e1111883f66d054b7985fce48ef3aa8
VIRTUALS_AGENT_ID=Poly_ryin Oracle
VIRTUALS_PRIVATE_KEY=0x_your_private_key
VIRTUALS_TOKEN=VIRTUAL

# Deployment / Scheduling
CRON_SCHEDULE=0 */4 * * *

# Optional
SENTRY_DSN=
PINATA_KEY=
PINATA_SECRET=

# API Configuration
REQUEST_TIMEOUT=20000
MAX_RETRIES=3

# Server Configuration
PORT=3001
NODE_ENV=production
LOG_LEVEL=INFO

# API Key for authentication
API_KEY=zigma-api-key-2024
```

Save and exit (Ctrl+X, Y, Enter).

### 4. Test Application Locally

```bash
# Test run
npm start

# If it works, stop with Ctrl+C
```

---

## Configure PM2

### 1. Create PM2 Ecosystem File

```bash
nano ecosystem.config.js
```

Add the following:

```javascript
module.exports = {
  apps: [{
    name: 'zigma-backend',
    script: './src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    time: true
  }]
};
```

### 2. Create Logs Directory

```bash
mkdir -p logs
```

### 3. Start Application with PM2

```bash
# Start the application
pm2 start ecosystem.config.js

# Check status
pm2 status

# View logs
pm2 logs zigma-backend

# Save PM2 configuration
pm2 save
```

### 4. Setup PM2 Startup Script

```bash
# Generate startup script
pm2 startup

# Copy and run the command shown (usually starts with sudo)
# Example: sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u zigma --hp /home/zigma
```

---

## Configure Nginx Reverse Proxy

### 1. Create Nginx Configuration

```bash
sudo nano /etc/nginx/sites-available/zigma-backend
```

Add the following configuration:

```nginx
# HTTP Server - Redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name api.zigma.pro;

    # Allow Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect all other HTTP traffic to HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.zigma.pro;

    # SSL Configuration (to be added in SSL section)
    # ssl_certificate /etc/letsencrypt/live/api.zigma.pro/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/api.zigma.pro/privkey.pem;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Logging
    access_log /var/log/nginx/zigma-backend-access.log;
    error_log /var/log/nginx/zigma-backend-error.log;

    # Reverse Proxy to Node.js App
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Health check endpoint (optional)
    location /health {
        proxy_pass http://127.0.0.1:3001/health;
        access_log off;
    }
}
```

### 2. Enable Site Configuration

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/zigma-backend /etc/nginx/sites-enabled/

# Test Nginx configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## Setup SSL Certificate

### 1. Install Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### 2. Obtain SSL Certificate

```bash
# Obtain certificate (this will auto-configure Nginx)
sudo certbot --nginx -d api.zigma.pro

# Follow prompts:
# - Enter email for renewal notices
# - Agree to Terms of Service
# - Choose whether to redirect HTTP to HTTPS (select Yes)
```

### 3. Verify SSL Configuration

```bash
# Check certificate status
sudo certbot certificates

# Test renewal (dry run)
sudo certbot renew --dry-run
```

### 4. Auto-Renewal Setup

Certbot automatically sets up a systemd timer for renewal. Verify:

```bash
sudo systemctl status certbot.timer
```

---

## Security Hardening

### 1. Configure Automatic Security Updates

```bash
# Install unattended-upgrades
sudo apt install -y unattended-upgrades

# Configure
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 2. Secure SSH Configuration

```bash
sudo nano /etc/ssh/sshd_config
```

Make these changes:

```
# Disable root login
PermitRootLogin no

# Disable password authentication (use only key-based)
PasswordAuthentication no

# Change default port (optional, recommended)
Port 2222

# Limit users
AllowUsers zigma
```

Restart SSH:

```bash
sudo systemctl restart sshd
```

### 3. Configure Fail2Ban

```bash
# Install Fail2Ban
sudo apt install -y fail2ban

# Create local configuration
sudo cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local

# Enable and start
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### 4. Additional Security Measures

```bash
# Install and configure firewall rules
sudo ufw allow 2222/tcp  # If you changed SSH port
sudo ufw deny 22/tcp     # Block default SSH port if changed
sudo ufw reload

# Set file permissions
chmod 600 ~/.env
chmod 700 ~/.ssh
```

---

## Monitoring & Maintenance

### 1. PM2 Monitoring

```bash
# Real-time monitoring
pm2 monit

# View logs
pm2 logs zigma-backend --lines 100

# Restart application
pm2 restart zigma-backend

# Check resource usage
pm2 show zigma-backend
```

### 2. Nginx Logs

```bash
# Access logs
sudo tail -f /var/log/nginx/zigma-backend-access.log

# Error logs
sudo tail -f /var/log/nginx/zigma-backend-error.log
```

### 3. Application Logs

```bash
# PM2 logs
pm2 logs zigma-backend

# Application-specific logs
tail -f ~/zigma-backend/logs/pm2-out.log
tail -f ~/zigma-backend/logs/pm2-error.log
```

### 4. System Monitoring

```bash
# Check disk space
df -h

# Check memory usage
free -h

# Check CPU usage
top

# Check system logs
sudo journalctl -xe
```

### 5. Backup Strategy

Create backup script:

```bash
nano ~/backup-zigma.sh
```

```bash
#!/bin/bash

# Backup script for Zigma backend
BACKUP_DIR="/home/zigma/backups"
DATE=$(date +%Y%m%d_%H%M%S)
APP_DIR="/home/zigma/zigma-backend"

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup database and cache
tar -czf $BACKUP_DIR/zigma-backup-$DATE.tar.gz \
  $APP_DIR/data \
  $APP_DIR/cache \
  $APP_DIR/.env

# Keep only last 7 days of backups
find $BACKUP_DIR -name "zigma-backup-*.tar.gz" -mtime +7 -delete

echo "Backup completed: zigma-backup-$DATE.tar.gz"
```

Make executable and add to cron:

```bash
chmod +x ~/backup-zigma.sh

# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * /home/zigma/backup-zigma.sh >> /home/zigma/backup.log 2>&1
```

### 6. Update Application

```bash
cd ~/zigma-backend

# Pull latest changes
git pull origin main

# Install new dependencies
npm install --production

# Restart PM2
pm2 restart zigma-backend
```

---

## Troubleshooting

### Application Not Starting

```bash
# Check PM2 logs
pm2 logs zigma-backend --err

# Check if port is in use
sudo netstat -tlnp | grep 3001

# Test application manually
cd ~/zigma-backend
npm start
```

### Nginx 502 Bad Gateway

```bash
# Check if PM2 is running
pm2 status

# Check if app is listening on port 3001
sudo netstat -tlnp | grep 3001

# Check Nginx error logs
sudo tail -f /var/log/nginx/zigma-backend-error.log
```

### SSL Certificate Issues

```bash
# Renew certificate manually
sudo certbot renew

# Check certificate status
sudo certbot certificates

# Re-obtain certificate if needed
sudo certbot --nginx -d api.zigma.pro --force-renewal
```

### High Memory Usage

```bash
# Check PM2 memory usage
pm2 show zigma-backend

# Restart if needed
pm2 restart zigma-backend

# Consider upgrading instance type if persistent
```

---

## Cost Optimization

### Recommended Instance Types

- **Development**: `t3.small` (1 vCPU, 2 GB RAM) - ~$15/month
- **Production**: `t3.medium` (2 vCPU, 4 GB RAM) - ~$30/month
- **High Traffic**: `t3.large` (2 vCPU, 8 GB RAM) - ~$60/month

### Savings Options

1. **Reserved Instances**: Save up to 75% for 1-3 year commitments
2. **Spot Instances**: Save up to 90% (not recommended for production)
3. **Auto Scaling**: Scale based on traffic patterns

---

## Alternative Deployment Options

### Option 1: AWS Elastic Beanstalk

```bash
# Create .ebextensions directory
mkdir .ebextensions

# Create configuration file
nano .ebextensions/01-nodejs.config
```

### Option 2: Docker + ECS

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3001
CMD ["node", "src/index.js"]
```

### Option 3: Render/Railway/Vercel (Simpler but less control)

- Push code to Git
- Connect platform to repository
- Set environment variables
- Deploy

---

## Quick Reference Commands

```bash
# PM2
pm2 start ecosystem.config.js    # Start app
pm2 restart zigma-backend        # Restart app
pm2 stop zigma-backend           # Stop app
pm2 logs zigma-backend           # View logs
pm2 monit                        # Monitor
pm2 save                         # Save config

# Nginx
sudo nginx -t                    # Test config
sudo systemctl reload nginx      # Reload config
sudo systemctl restart nginx     # Restart service

# SSL
sudo certbot renew               # Renew certificates
sudo certbot --dry-run           # Test renewal

# System
sudo ufw status                  # Check firewall
sudo systemctl status nginx      # Check Nginx status
pm2 status                       # Check app status
```

---

## Support & Documentation

- AWS EC2 Documentation: https://docs.aws.amazon.com/ec2/
- PM2 Documentation: https://pm2.keymetrics.io/docs/
- Nginx Documentation: https://nginx.org/en/docs/
- Certbot Documentation: https://certbot.eff.org/docs/

---

## Checklist

- [ ] EC2 instance created and running
- [ ] Security group configured
- [ ] Elastic IP allocated and DNS updated
- [ ] Node.js 20.x installed
- [ ] PM2 installed and configured
- [ ] Nginx installed and configured
- [ ] Application deployed and running
- [ ] SSL certificate installed
- [ ] Security hardening completed
- [ ] Backup strategy implemented
- [ ] Monitoring configured
- [ ] DNS propagation complete
- [ ] Application accessible at https://api.zigma.pro

---

**Last Updated**: January 2026
**Version**: 1.0
