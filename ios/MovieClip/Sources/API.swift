import Foundation

struct Clip: Decodable, Identifiable, Equatable {
    struct Source: Decodable, Equatable {
        let url: URL?
        let title: String?
        let startSeconds: Int?
    }

    let id: String
    let title: String
    let description: String?
    let tags: [String]
    let source: Source?
    let durationSeconds: Double?
    let width: Int?
    let height: Int?
    let viewCount: Int
    let videoUrl: URL
    let posterUrl: URL?

    var isLandscape: Bool {
        guard let width, let height else { return false }
        return width > height
    }

    /// YouTube なら開始位置つきで開く
    var sourceLink: URL? {
        guard let url = source?.url else { return nil }
        guard let start = source?.startSeconds, start > 0,
              let host = url.host(), host.hasSuffix("youtube.com") || host == "youtu.be",
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return url }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "t" }
        items.append(URLQueryItem(name: "t", value: "\(start)s"))
        components.queryItems = items
        return components.url ?? url
    }
}

struct FeedPage: Decodable {
    let clips: [Clip]
    let nextCursor: String?
}

enum APIError: Error {
    case unauthorized
    case http(Int)
}

/// 視聴 API。認証は Access の JWT を `cf-access-token` ヘッダで送る
struct API {
    let token: String

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    func feed(cursor: String?, tag: String?) async throws -> FeedPage {
        var components = URLComponents(url: Server.origin.appending(path: "api/feed"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            cursor.map { URLQueryItem(name: "cursor", value: $0) },
            tag.map { URLQueryItem(name: "tag", value: $0) },
        ].compactMap { $0 }
        return try await send(URLRequest(url: components.url!), as: FeedPage.self)
    }

    func clip(id: String) async throws -> Clip {
        struct Wrapper: Decodable { let clip: Clip }
        return try await send(URLRequest(url: clipURL(id)), as: Wrapper.self).clip
    }

    func recordView(id: String) async throws {
        var request = URLRequest(url: clipURL(id).appending(path: "view"))
        request.httpMethod = "POST"
        _ = try await data(for: request)
    }

    func delete(id: String) async throws {
        var request = URLRequest(url: clipURL(id))
        request.httpMethod = "DELETE"
        _ = try await data(for: request)
    }

    private func clipURL(_ id: String) -> URL {
        Server.origin.appending(path: "api/clips").appending(path: id)
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        try Self.decoder.decode(T.self, from: try await data(for: request))
    }

    private func data(for request: URLRequest) async throws -> Data {
        var request = request
        request.setValue(token, forHTTPHeaderField: "cf-access-token")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.http(0) }
        // Access のセッションが切れているとログイン画面へリダイレクトされる
        if http.statusCode == 401 || http.statusCode == 403 || http.url?.host()?.hasSuffix("cloudflareaccess.com") == true {
            throw APIError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else { throw APIError.http(http.statusCode) }
        return data
    }
}
