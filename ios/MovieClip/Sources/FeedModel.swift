import Foundation
import Observation

@MainActor
@Observable
final class FeedModel {
    private(set) var clips: [Clip] = []
    private(set) var loading = false
    private(set) var loadedOnce = false
    private(set) var tag: String?
    /// シャッフル順か新着順か。端末に保存する
    private(set) var shuffled = UserDefaults.standard.bool(forKey: "shuffled")
    var errorMessage: String?

    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var done = false
    /// 並び順やタグを変えたら進める。読み込み中だった古い結果を捨てるため
    @ObservationIgnored private var generation = 0
    /// 取り直しが続けて失敗するときに、同じ動画で無限に取り直さないようにする
    @ObservationIgnored private var refreshedAt: [String: Date] = [:]
    @ObservationIgnored private let auth: AuthStore

    /// 残りがこの本数になったら次のページを読む
    private let prefetchRemaining = 3

    init(auth: AuthStore) {
        self.auth = auth
    }

    private var api: API { API(token: auth.token) }

    /// 削除は Access を通った人だけ
    var canDelete: Bool { auth.isSignedIn }

    func reload(tag: String? = nil) async {
        self.tag = tag
        cursor = nil
        done = false
        generation += 1
        loading = false
        clips = []
        loadedOnce = false
        await loadMore()
    }

    func setShuffled(_ value: Bool) async {
        shuffled = value
        UserDefaults.standard.set(value, forKey: "shuffled")
        await reload(tag: tag)
    }

    func loadMoreIfNeeded(currentIndex: Int) async {
        if clips.count - currentIndex <= prefetchRemaining { await loadMore() }
    }

    func loadMore() async {
        guard !loading, !done else { return }
        loading = true
        let started = generation
        defer {
            if started == generation { loading = false; loadedOnce = true }
        }
        do {
            let page = try await api.feed(cursor: cursor, tag: tag, shuffled: shuffled)
            guard started == generation else { return }
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
        guard let index = clips.firstIndex(where: { $0.id == id }) else { return }
        do {
            clips[index] = try await api.clip(id: id)
        } catch {
            handle(error)
        }
    }

    func recordView(id: String) {
        let api = api
        Task { try? await api.recordView(id: id) }
    }

    func delete(id: String) async {
        do {
            try await api.delete(id: id)
            clips.removeAll { $0.id == id }
        } catch {
            handle(error)
        }
    }

    private func handle(_ error: Error) {
        if case APIError.unauthorized = error {
            auth.requireLogin()
        } else if (error as? URLError)?.code != .cancelled {
            errorMessage = "読み込めませんでした"
        }
    }
}
