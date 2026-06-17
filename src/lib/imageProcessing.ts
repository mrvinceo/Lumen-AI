/**
 * Utility to compress and resize images before uploading/sending to Gemini
 */
export async function compressImage(
  base64: string,
  maxWidth: number = 1600,
  maxHeight: number = 1600,
  quality: number = 0.8
): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = base64;
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      // Calculate new dimensions
      if (width > height) {
        if (width > maxWidth) {
          height *= maxWidth / width;
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width *= maxHeight / height;
          height = maxHeight;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      // Convert to JPEG for best compression ratio vs quality for photographs
      const compressedBase64 = canvas.toDataURL("image/jpeg", quality);
      const data = compressedBase64.split(",")[1];
      
      resolve({
        data,
        mimeType: "image/jpeg"
      });
    };
    img.onerror = (err) => reject(err);
  });
}
