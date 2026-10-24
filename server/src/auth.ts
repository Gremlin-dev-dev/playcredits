import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { HttpError } from './errors';

export const COOKIE = 'sid';
const WEEK_MS = 7 * 24 * 3600 * 1000;

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

export function setSession(res: Response, userId: string) {
  const token = jwt.sign({ sub: userId }, config.JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: WEEK_MS,
  });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production' });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next(new HttpError(401, 'Authentication required'));
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as { sub?: string };
    if (!payload.sub) throw new Error('no sub');
    req.userId = payload.sub;
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired session'));
  }
}

/** CSRF defence in depth: cookies are SameSite=Lax; also reject cross-origin state changes. */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== config.CLIENT_ORIGIN) return next(new HttpError(403, 'Origin not allowed'));
  next();
}
