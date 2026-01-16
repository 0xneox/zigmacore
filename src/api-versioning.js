/**
 * API Versioning Middleware
 * Provides version control for API endpoints
 */

const API_VERSIONS = {
  'v1': {
    deprecated: false,
    sunsetDate: null,
    features: ['basic', 'signals', 'watchlist', 'analytics']
  },
  'v2': {
    deprecated: false,
    sunsetDate: null,
    features: ['basic', 'signals', 'watchlist', 'analytics', 'realtime', 'advanced-risks']
  }
};

const CURRENT_VERSION = 'v2';

/**
 * API Versioning Middleware
 */
function apiVersioning(req, res, next) {
  // Extract version from URL path or header
  const pathVersion = req.path.match(/^\/api\/(v\d+)/)?.[1];
  const headerVersion = req.headers['api-version'];
  const version = pathVersion || headerVersion || CURRENT_VERSION;

  // Validate version
  if (!API_VERSIONS[version]) {
    return res.status(400).json({
      error: 'Invalid API version',
      message: `Version ${version} is not supported. Available versions: ${Object.keys(API_VERSIONS).join(', ')}`,
      currentVersion: CURRENT_VERSION,
      code: 'INVALID_VERSION'
    });
  }

  // Check if version is deprecated
  const versionInfo = API_VERSIONS[version];
  if (versionInfo.deprecated) {
    res.setHeader('X-API-Deprecated', 'true');
    res.setHeader('X-API-Sunset-Date', versionInfo.sunsetDate);
    res.setHeader('X-API-Current-Version', CURRENT_VERSION);
  }

  // Add version info to request
  req.apiVersion = version;
  req.apiVersionInfo = versionInfo;

  // Add version headers to response
  res.setHeader('X-API-Version', version);
  res.setHeader('X-API-Current-Version', CURRENT_VERSION);

  next();
}

/**
 * Version compatibility check
 */
function checkVersionCompatibility(clientVersion, requiredVersion = CURRENT_VERSION) {
  const clientMajor = parseInt(clientVersion.replace('v', ''));
  const requiredMajor = parseInt(requiredVersion.replace('v', ''));

  return clientMajor >= requiredMajor;
}

/**
 * Get version-specific endpoint
 */
function getVersionedEndpoint(basePath, version = CURRENT_VERSION) {
  return `/api/${version}${basePath}`;
}

/**
 * Version deprecation warning
 */
function getDeprecationWarning(version) {
  const versionInfo = API_VERSIONS[version];
  if (!versionInfo || !versionInfo.deprecated) {
    return null;
  }

  return {
    warning: `API version ${version} is deprecated`,
    sunsetDate: versionInfo.sunsetDate,
    migrateTo: CURRENT_VERSION,
    migrationGuide: '/docs/api-migration'
  };
}

module.exports = {
  apiVersioning,
  checkVersionCompatibility,
  getVersionedEndpoint,
  getDeprecationWarning,
  API_VERSIONS,
  CURRENT_VERSION
};
