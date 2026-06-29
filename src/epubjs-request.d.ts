declare module '@flow/epubjs/src/utils/request' {
  export default function request(
    url: string,
    type?: string | null,
    withCredentials?: boolean,
    headers?: Record<string, string>,
  ): Promise<any>
}
