import AVFoundation
import Observation

/// 表示中の1本と前後1本ぶんだけ AVPlayer を持つ。スワイプした先がすでに読み込み済みなので、すぐ再生が始まる。
/// それより遠いものは捨ててメモリと帯域を返す。
@MainActor
@Observable
final class PlayerPool {
    private(set) var activeID: String?
    private(set) var progress: Double = 0
    private(set) var isPaused = false
    var muted = UserDefaults.standard.bool(forKey: "muted") {
        didSet {
            UserDefaults.standard.set(muted, forKey: "muted")
            for entry in entries.values { entry.player.isMuted = muted }
        }
    }

    /// 2 秒見たら呼ぶ（再生回数）
    @ObservationIgnored var onViewed: ((String) -> Void)?
    /// 署名付き URL の失効などで読めなかったとき
    @ObservationIgnored var onFailed: ((String) -> Void)?

    private struct Entry {
        let url: URL
        let player: AVQueuePlayer
        let looper: AVPlayerLooper
        let statusObservation: NSKeyValueObservation
    }

    @ObservationIgnored private var entries: [String: Entry] = [:]
    @ObservationIgnored private var timeObserver: (player: AVPlayer, token: Any)?
    @ObservationIgnored private var viewed: Set<String> = []

    func player(for id: String) -> AVPlayer? {
        entries[id]?.player
    }

    /// index の前後1本を用意し、それ以外を捨てる
    func prepare(_ clips: [Clip], around index: Int) {
        guard clips.indices.contains(index) else { return }
        let wanted = clips[max(0, index - 1)...min(clips.count - 1, index + 1)]
        let wantedIDs = Set(wanted.map(\.id))
        for (id, entry) in entries where !wantedIDs.contains(id) {
            entry.player.pause()
            entry.looper.disableLooping()
            entries[id] = nil
        }
        for clip in wanted {
            // URL が変わった（取り直した）ものは作り直す
            if let entry = entries[clip.id], entry.url == clip.videoUrl { continue }
            entries[clip.id]?.player.pause()
            entries[clip.id] = makeEntry(for: clip)
        }
    }

    func activate(_ id: String) {
        if let observer = timeObserver {
            observer.player.removeTimeObserver(observer.token)
            timeObserver = nil
        }
        activeID = id
        progress = 0
        isPaused = false
        for (entryID, entry) in entries where entryID != id {
            entry.player.pause()
        }
        guard let player = entries[id]?.player else { return }
        player.seek(to: .zero)
        player.play()

        let token = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, let item = player.currentItem else { return }
                let duration = item.duration.seconds
                if duration.isFinite, duration > 0 {
                    self.progress = time.seconds / duration
                }
                if time.seconds >= 2, !self.viewed.contains(id) {
                    self.viewed.insert(id)
                    self.onViewed?(id)
                }
            }
        }
        timeObserver = (player, token)
    }

    func togglePause() {
        guard let id = activeID, let player = entries[id]?.player else { return }
        if player.timeControlStatus == .paused {
            player.play()
            isPaused = false
        } else {
            player.pause()
            isPaused = true
        }
    }

    /// アプリが裏に回ったときなど
    func pauseAll() {
        for entry in entries.values { entry.player.pause() }
        isPaused = true
    }

    func resume() {
        guard let id = activeID, isPaused else { return }
        entries[id]?.player.play()
        isPaused = false
    }

    func reset() {
        pauseAll()
        if let observer = timeObserver {
            observer.player.removeTimeObserver(observer.token)
            timeObserver = nil
        }
        entries.removeAll()
        activeID = nil
    }

    private func makeEntry(for clip: Clip) -> Entry {
        let item = AVPlayerItem(url: clip.videoUrl)
        // ショートは短いので、先読みは控えめでも途切れない
        item.preferredForwardBufferDuration = 5
        let player = AVQueuePlayer()
        player.isMuted = muted
        player.preventsDisplaySleepDuringVideoPlayback = true
        let looper = AVPlayerLooper(player: player, templateItem: item)
        let id = clip.id
        let observation = looper.observe(\.status) { [weak self] looper, _ in
            guard looper.status == .failed else { return }
            Task { @MainActor in self?.onFailed?(id) }
        }
        return Entry(url: clip.videoUrl, player: player, looper: looper, statusObservation: observation)
    }
}
