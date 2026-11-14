import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@tickdoctor/shared";

// Cheap gate: no session cookie → /login. The API still checks the session on every call
// (and the app shell handles a 401 from an expired cookie).
export function middleware(req: NextRequest) {
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const url = req.nextUrl.clone();
  const next = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/app", "/app/:path*"] };
