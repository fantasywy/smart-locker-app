// `13.17` 上传文件响应的**手写 DTO** —— 只有形状，没有行为。
//
// 契约：后端的 `AppFileVO`（`POST /api/app/v1/files` 的 `data`）：
//
// ```json
// { "id": 42, "url": "/api/app/v1/files/42", "size": 18324,
//   "mime": "image/png", "width": 1080, "height": 1080 }
// ```
//
// ⚠️ **客户端只认 `url`**：上传成功后写进 `PUT /profile` 的是它，缓存命名从它解析出的
// `fileId` 取。`id` 只是契约字段，不参与任何客户端逻辑（尤其不得用它拼请求路径）。
//
// ⚠️ 本模块遵守类型层的既定规则：不发明字段、不改字段名、可空显式标 `| null`
// （本 DTO 六个字段在契约里都不可空）。

/** `POST /api/app/v1/files` 成功响应里的 `data`。 */
export interface AppFile {
  /** `file_object.id`。**只读、不参与客户端逻辑**（不得用它拼任何东西）。 */
  id: number

  /** 恒为 `/api/app/v1/files/{id}` —— 客户端唯一认可的地址。 */
  url: string

  /** 实际写入对象存储的字节数。 */
  size: number

  /** 服务端嗅探的 MIME（`image/jpeg` / `image/png` / `image/webp`）。 */
  mime: string

  /** 像素宽度（不含 EXIF 方向）。 */
  width: number

  /** 像素高度（不含 EXIF 方向）。 */
  height: number
}
