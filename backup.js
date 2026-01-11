const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Backup configuration
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const DB_PATH = path.join(__dirname, '..', 'data', 'cache.sqlite');
const MAX_BACKUPS = 7; // Keep 7 days of backups
const BACKUP_RETENTION_DAYS = 7;

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Create a backup of the SQLite database
 */
function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `cache_backup_${timestamp}.db`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);

    // Copy database file to backup location
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, backupPath);
      console.log(`✅ Backup created: ${backupFileName}`);
      
      // Compress backup
      compressBackup(backupPath);
      
      // Clean up old backups
      cleanupOldBackups();
      
      return { success: true, backupFile: backupFileName };
    } else {
      console.warn('⚠️ Database file not found, skipping backup');
      return { success: false, error: 'Database file not found' };
    }
  } catch (error) {
    console.error('❌ Backup failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Compress backup file using gzip
 */
function compressBackup(filePath) {
  try {
    const compressedPath = `${filePath}.gz`;
    execSync(`gzip -c "${filePath}" > "${compressedPath}"`);
    fs.unlinkSync(filePath); // Remove uncompressed backup
    console.log(`✅ Backup compressed: ${path.basename(compressedPath)}`);
  } catch (error) {
    console.warn('⚠️ Compression failed (gzip not available):', error.message);
    // Keep uncompressed backup if compression fails
  }
}

/**
 * Clean up old backups exceeding retention period
 */
function cleanupOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR);
    const now = Date.now();
    const retentionMs = BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // Sort files by creation time (newest first)
    const sortedFiles = files
      .map(file => ({
        name: file,
        path: path.join(BACKUP_DIR, file),
        time: fs.statSync(path.join(BACKUP_DIR, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);

    // Delete old backups
    let deletedCount = 0;
    for (const file of sortedFiles) {
      // Delete if older than retention period or if we have too many backups
      if (file.time < now - retentionMs || deletedCount >= MAX_BACKUPS) {
        fs.unlinkSync(file.path);
        console.log(`🗑️ Deleted old backup: ${file.name}`);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      console.log(`✅ Cleaned up ${deletedCount} old backup(s)`);
    }
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
}

/**
 * Restore database from backup
 */
function restoreBackup(backupFileName) {
  try {
    const backupPath = path.join(BACKUP_DIR, backupFileName);
    
    if (!fs.existsSync(backupPath)) {
      return { success: false, error: 'Backup file not found' };
    }

    // Decompress if needed
    let restorePath = backupPath;
    if (backupPath.endsWith('.gz')) {
      restorePath = backupPath.replace('.gz', '');
      execSync(`gunzip -c "${backupPath}" > "${restorePath}"`);
    }

    // Stop any running database operations
    // (This should be called when the application is not running)

    // Create backup of current database before restore
    const currentBackup = `pre_restore_${Date.now()}.db`;
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, currentBackup));
    }

    // Restore from backup
    fs.copyFileSync(restorePath, DB_PATH);
    
    console.log(`✅ Database restored from: ${backupFileName}`);
    return { success: true, backupFile: backupFileName };
  } catch (error) {
    console.error('❌ Restore failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * List available backups
 */
function listBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR);
    return files
      .map(file => {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          created: stats.mtime,
          compressed: file.endsWith('.gz')
        };
      })
      .sort((a, b) => b.created - a.created);
  } catch (error) {
    console.error('❌ Failed to list backups:', error);
    return [];
  }
}

/**
 * Verify backup integrity
 */
function verifyBackup(backupFileName) {
  try {
    const backupPath = path.join(BACKUP_DIR, backupFileName);
    
    if (!fs.existsSync(backupPath)) {
      return { success: false, error: 'Backup file not found' };
    }

    // Check file size
    const stats = fs.statSync(backupPath);
    if (stats.size === 0) {
      return { success: false, error: 'Backup file is empty' };
    }

    // Try to open as SQLite database
    const Database = require('better-sqlite3');
    let tempDb;
    
    if (backupPath.endsWith('.gz')) {
      // Decompress to temp file
      const tempPath = `${backupPath}.temp`;
      execSync(`gunzip -c "${backupPath}" > "${tempPath}"`);
      tempDb = new Database(tempPath);
      fs.unlinkSync(tempPath);
    } else {
      tempDb = new Database(backupPath);
    }

    // Check if database is valid
    const result = tempDb.prepare('SELECT name FROM sqlite_master WHERE type="table"').all();
    tempDb.close();

    if (result.length === 0) {
      return { success: false, error: 'Backup file is not a valid database' };
    }

    return { success: true, tables: result.length };
  } catch (error) {
    console.error('❌ Verification failed:', error);
    return { success: false, error: error.message };
  }
}

// Schedule automatic daily backups
if (require.main === module) {
  console.log('🔄 Starting backup service...');
  
  // Create initial backup
  createBackup();

  // Schedule daily backup at 2 AM
  const scheduleBackup = () => {
    const now = new Date();
    const nextBackup = new Date(now);
    nextBackup.setHours(2, 0, 0, 0);
    
    if (nextBackup <= now) {
      nextBackup.setDate(nextBackup.getDate() + 1);
    }
    
    const delay = nextBackup - now;
    console.log(`⏰ Next backup scheduled for: ${nextBackup.toISOString()}`);
    
    setTimeout(() => {
      createBackup();
      // Schedule next backup
      setInterval(createBackup, 24 * 60 * 60 * 1000);
    }, delay);
  };

  scheduleBackup();

  // Export functions for programmatic use
  module.exports = {
    createBackup,
    restoreBackup,
    listBackups,
    verifyBackup,
    cleanupOldBackups
  };
} else {
  module.exports = {
    createBackup,
    restoreBackup,
    listBackups,
    verifyBackup,
    cleanupOldBackups
  };
}
