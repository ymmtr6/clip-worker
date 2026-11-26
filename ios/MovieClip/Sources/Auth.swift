import AuthenticationServices
import Foundation
import Observation
import Security
import UIKit

enum Server {
    static let origin: URL = {
        #if DEBUG
        // シミュレータから wrangler dev に繋ぐとき用（スキームの環境変数で指定）
        if let value = ProcessInfo.processInfo.environment["CLIP_ORIGIN"], let url = URL(string: value) {
            return url
        }
        #endif
        return URL(string: "https://clip.riyamamo.com/")!
    }()
}

/// Cloudflare Access のログイン。
///
/// ASWebAuthenticationSession で Worker の `/api/app-auth` を開くと、Access → Google ログイン →
/// Worker の順に進み、Worker が Access の JWT を `movieclip://auth?token=...` で返してくる。
/// 以降の API 呼び出しはこの JWT を `cf-access-token` ヘッダで送る。
@MainActor
@Observable
final class AuthStore: NSObject, ASWebAuthenticationPresentationContextProviding {
    private(set) var token: String?
    private(set) var signingIn = false
    /// 視聴 API が認証を求めたとき（401 や Access へのリダイレクト）。公開モードのあいだはログインなしで見られる
    private(set) var needsLogin = false
    var lastError: String?

    private var session: ASWebAuthenticationSession?

    override init() {
        super.init()
        if let saved = Keychain.read(), !Self.isExpired(saved) {
            token = saved
        }
        #if DEBUG
        // wrangler dev は DEV_VIEWER_EMAIL で素通しになるので、ログインを飛ばす
        if let dev = ProcessInfo.processInfo.environment["CLIP_DEV_TOKEN"] {
            token = dev
        }
        #endif
    }

    var isSignedIn: Bool { token != nil }

    func signIn() async {
        guard !signingIn else { return }
        signingIn = true
        defer { signingIn = false }
        do {
            let callback: URL = try await withCheckedThrowingContinuation { continuation in
                let session = ASWebAuthenticationSession(
                    url: Server.origin.appending(path: "api/app-auth"),
                    callbackURLScheme: "movieclip"
                ) { url, error in
                    if let url {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: error ?? URLError(.userCancelledAuthentication))
                    }
                }
                session.presentationContextProvider = self
                // Google のログイン状態を Safari 側に残し、次回からはワンタップで済ませる
                session.prefersEphemeralWebBrowserSession = false
                self.session = session
                session.start()
            }
            session = nil
            let value = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "token" }?.value
            guard let value, !value.isEmpty else { throw URLError(.userAuthenticationRequired) }
            Keychain.save(value)
            token = value
            needsLogin = false
            lastError = nil
        } catch {
            session = nil
            if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                lastError = "ログインできませんでした"
            }
        }
    }

    /// 期限切れや 401 のとき。ログイン画面に戻す
    func requireLogin() {
        Keychain.delete()
        token = nil
        needsLogin = true
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }

    /// JWT の exp を見る。署名の検証は Access と Worker が行う
    static func isExpired(_ token: String) -> Bool {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return false }
        var base64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard
            let data = Data(base64Encoded: base64),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let exp = payload["exp"] as? TimeInterval
        else { return false }
        return Date(timeIntervalSince1970: exp) < Date()
    }
}

private enum Keychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.riyamamo.movieclip",
        kSecAttrAccount as String: "access-token",
    ]

    static func read() -> String? {
        var item: CFTypeRef?
        var search = query
        search[kSecReturnData as String] = true
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String) {
        delete()
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}
