export default function request(
  url: string,
  type?: string | null,
  withCredentials?: boolean,
  headers?: object,
): Promise<Blob | string | JSON | Document | XMLDocument>
