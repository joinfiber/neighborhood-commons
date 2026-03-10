/**
 * IP Filter Middleware — The Fiber Commons
 *
 * Blocks requests from known datacenter IP ranges on sensitive endpoints.
 * Simplified version: no audit logging dependency (Commons doesn't have the
 * full audit infrastructure; datacenter blocks are logged to stdout).
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

// Known datacenter IP ranges (AWS, GCP, Azure common prefixes)
// This is a simplified check — for production, use a maintained IP range database
const DATACENTER_PREFIXES = [
  '3.', '13.', '15.', '18.', '34.', '35.', '44.', '50.', '52.', '54.', '99.',  // AWS
  '104.196.', '104.197.', '104.198.', '104.199.', '35.184.', '35.192.', '35.200.', '35.208.', '35.216.', '35.224.', '35.232.', '35.240.', // GCP
  '20.', '40.', '52.', '104.40.', '104.41.', '104.42.', '104.43.', '104.44.', '104.45.', '104.46.', // Azure
];

function isDatacenterIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return DATACENTER_PREFIXES.some(prefix => ip.startsWith(prefix));
}

export function blockDatacenterIps(req: Request, res: Response, next: NextFunction): void {
  if (!config.security.ipFilterEnabled) {
    next();
    return;
  }

  if (isDatacenterIp(req.ip)) {
    console.warn(`[IP-FILTER] Blocked datacenter IP: ${req.ip?.substring(0, 10)}*** on ${req.path}`);
    res.status(403).json({
      error: { code: 'ACCESS_DENIED', message: 'Access denied' },
    });
    return;
  }

  next();
}
