import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { assertValidTable } from "@/lib/admin-db";
import { saveImage } from "@/lib/storage";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export async function POST(request: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const table = String(formData.get("table") ?? "");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "Only image files are allowed." },
        { status: 400 }
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Image is too large (max 15 MB)." },
        { status: 400 }
      );
    }

    await assertValidTable(table);

    const buffer = Buffer.from(await file.arrayBuffer());
    const saved = await saveImage(table, file.name, buffer, file.type);

    return NextResponse.json(saved);
  } catch (error) {
    console.error("Image upload failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to upload image.",
      },
      { status: 500 }
    );
  }
}
