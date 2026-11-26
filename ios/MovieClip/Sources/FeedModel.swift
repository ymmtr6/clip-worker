import Foundation
import Observation

@MainActor
@Observable
final class FeedModel {
    private(set) var clips: [Clip] = []
    private(set) var loading = false
    private(set) var loadedOnce = false
    private(set) var tag: String?
    var errorMessage: String?

    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var done = false
    /// 取り直しが続けて失敗するときに、同じ動画で無限に取り直さないようにする
    @ObservationIgnored private var refreshedAt: [String: Date] = [:]
    @ObservationIgnored private let auth: AuthStore

    /// 残りがこの本数になったら次のページを読む
    private let prefetchRemaining = 3

    init(auth: AuthStore) {
        self.auth = auth
    }

    private var api: API? {
        auth.token.map { API(token: $0) }
    }

    func reload(tag: String? = nil) async {
        self.tag = tag
        cursor = nil
        done = false
        clips = []
        loadedOnce = false
        await loadMore()
    }

    func loadMoreIfNeeded(currentIndex: Int) async {
        if clips.count - currentIndex <= prefetchRemaining { await loadMore() }
    }

    func loadMore() async {
        guard !loading, !done, let api else { return }
        loading = true
        defer { loading = false; loadedOnce = true }
        do {
            let page = try await api.feed(cursor: cursor, tag: tag)
            let known = Set(clips.map(\.id))
            clips.append(contentsOf: page.clips.filter { !known.contains($0.id) })
            cursor = page.nextCursor
            done = page.nextCursor == nil
            errorMessage = nil
        } catch {
            handle(error)
        }
    }

    /// 署名付き URL が切れたものを取り直す
    func refresh(id: String) async {
        if let last = refreshedAt[id], Date().timeIntervalSince(last) < 10 { return }
        refreshedAt[id] = Date()
        guard let api, let index = clips.firstIndex(where: { $0.id == id }) else { return }
        do {
            clips[index] = try await api.clip(id: id)
        } catch {
            handle(error)
        }
    }

    func recordView(id: String) {
        guard let api else { return }
        Task { try? await api.recordView(id: id) }
    }

    func delete(id: String) async {
        guard let api else { return }
        do {
            try await api.delete(id: id)
            clips.removeAll { $0.id == id }
        } catch {
            handle(error)
        }
    }

    private func handle(_ error: Error) {
        if case APIError.unauthorized = error {
            auth.signOut()
        } else if (error as? URLError)?.code != .cancelled {
            errorMessage = "読み込めませんでした"
        }
    }
}
