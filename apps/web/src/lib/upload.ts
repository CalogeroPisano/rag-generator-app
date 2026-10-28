/** Upload of a zip archive to `POST /api/uploads` (new project or new version). */

/**
 * Sends the archive as the raw request body. XMLHttpRequest (rather than
 * fetch) is used because it reports upload progress.
 */
export const uploadArchive = (file: File, onProgress: (fraction: number) => void) =>
  new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("POST", "/api/uploads")
    request.setRequestHeader("Content-Type", "application/zip")
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      const body = (() => {
        try {
          return JSON.parse(request.responseText) as { uploadId?: string; error?: string }
        } catch {
          return {}
        }
      })()
      if (request.status === 201 && body.uploadId !== undefined) resolve(body.uploadId)
      else reject(new Error(body.error ?? "Caricamento non riuscito"))
    }
    request.onerror = () => reject(new Error("Connessione interrotta durante il caricamento"))
    request.send(file)
  })
