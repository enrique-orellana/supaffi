import { NextResponse } from "next/server";

export async function POST(_request: Request) {
  return NextResponse.json(
    {
      error:
        "Checkout creation through Supaffi is disabled. Keep your existing checkout and relay payment events to Supaffi.",
    },
    { status: 410 }
  );
}
