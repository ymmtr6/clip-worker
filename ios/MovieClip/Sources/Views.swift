import AVFoundation
import SwiftUI

@main
struct MovieClipApp: App {
    @State private var auth = AuthStore()

    init() {
        // マナーモードでも音が出るようにする（ミュートはアプリ内のボタンで切り替える）
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if auth.isSignedIn {
                    FeedView(auth: auth)
                } else {
                    LoginView(auth: auth)
                }
            }
            .preferredColorScheme(.dark)
        }
    }
}

struct LoginView: View {
    let auth: AuthStore

    var body: some View {
        VStack(spacing: 20) {
            Text("Clip").font(.system(size: 40, weight: .heavy))
            Button {
                Task { await auth.signIn() }
            } label: {
                Text(auth.signingIn ? "ログイン中…" : "ログイン")
                    .font(.headline)
                    .frame(maxWidth: 240)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(.pink)
            .disabled(auth.signingIn)
            if let error = auth.lastError {
                Text(error).foregroundStyle(.secondary).font(.footnote)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }
}

struct FeedView: View {
    @State private var model: FeedModel
    @State private var pool = PlayerPool()
    @State private var activeID: String?
    @Environment(\.scenePhase) private var scenePhase

    init(auth: AuthStore) {
        _model = State(initialValue: FeedModel(auth: auth))
    }

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(spacing: 0) {
                ForEach(model.clips) { clip in
                    ClipPage(
                        clip: clip,
                        player: pool.player(for: clip.id),
                        isActive: pool.activeID == clip.id,
                        pool: pool,
                        onTag: { tag in Task { await reload(tag: tag) } },
                        onDelete: { Task { await model.delete(id: clip.id) } }
                    )
                    .containerRelativeFrame([.horizontal, .vertical])
                    .id(clip.id)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $activeID)
        .scrollIndicators(.hidden)
        .ignoresSafeArea()
        .background(Color.black)
        .overlay(alignment: .top) { topBar }
        .overlay { emptyState }
        .task {
            pool.onViewed = { id in model.recordView(id: id) }
            pool.onFailed = { id in Task { await model.refresh(id: id) } }
            if model.clips.isEmpty { await model.loadMore() }
        }
        .onChange(of: model.clips) { _, clips in
            if activeID == nil || !clips.contains(where: { $0.id == activeID }) {
                activeID = clips.first?.id
            }
            syncPlayers()
        }
        .onChange(of: activeID) { _, _ in syncPlayers() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { pool.resume() } else { pool.pauseAll() }
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Text("Clip").font(.title3.weight(.heavy))
            if let tag = model.tag {
                Button {
                    Task { await reload(tag: nil) }
                } label: {
                    Label("#\(tag)", systemImage: "xmark")
                        .labelStyle(TrailingIconLabelStyle())
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: Capsule())
                }
            }
            Spacer()
            Button {
                pool.muted.toggle()
            } label: {
                Image(systemName: pool.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .frame(width: 44, height: 44)
                    .background(.black.opacity(0.35), in: Circle())
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
    }

    @ViewBuilder
    private var emptyState: some View {
        if model.clips.isEmpty {
            VStack(spacing: 12) {
                if model.loading || !model.loadedOnce {
                    ProgressView()
                } else {
                    Text(model.errorMessage ?? "まだ切り抜きがありません").foregroundStyle(.secondary)
                    Button("再読み込み") { Task { await model.reload(tag: model.tag) } }
                }
            }
        }
    }

    private func reload(tag: String?) async {
        pool.reset()
        activeID = nil
        await model.reload(tag: tag)
    }

    private func syncPlayers() {
        guard let id = activeID, let index = model.clips.firstIndex(where: { $0.id == id }) else { return }
        pool.prepare(model.clips, around: index)
        if pool.activeID != id || pool.player(for: id)?.currentItem == nil {
            pool.activate(id)
        }
        Task { await model.loadMoreIfNeeded(currentIndex: index) }
    }
}

struct ClipPage: View {
    let clip: Clip
    let player: AVPlayer?
    let isActive: Bool
    let pool: PlayerPool
    let onTag: (String) -> Void
    let onDelete: () -> Void

    @State private var confirmingDelete = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            Color.black
            if let poster = clip.posterUrl {
                AsyncImage(url: poster) { image in
                    image.resizable().aspectRatio(contentMode: clip.isLandscape ? .fit : .fill)
                } placeholder: {
                    Color.black
                }
            }
            if let player {
                PlayerLayerView(player: player, fill: !clip.isLandscape)
            }
            if isActive && pool.isPaused {
                Image(systemName: "play.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.white.opacity(0.85))
                    .shadow(radius: 8)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if isActive { pool.togglePause() } }
        .overlay(alignment: .bottom) { meta }
        .clipped()
        .confirmationDialog("「\(clip.title)」を削除しますか？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("削除", role: .destructive, action: onDelete)
        }
    }

    private var meta: some View {
        VStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(clip.title)
                        .font(.headline)
                        .lineLimit(3)
                    if let description = clip.description {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(.white.opacity(0.75))
                            .lineLimit(2)
                    }
                    if !clip.tags.isEmpty {
                        ScrollView(.horizontal) {
                            HStack(spacing: 8) {
                                ForEach(clip.tags, id: \.self) { tag in
                                    Button("#\(tag)") { onTag(tag) }
                                        .font(.footnote.weight(.semibold))
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                    }
                    if let link = clip.sourceLink {
                        Button {
                            openURL(link)
                        } label: {
                            Label(sourceLabel, systemImage: "arrow.up.right.square")
                                .font(.caption)
                                .lineLimit(1)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.white.opacity(0.3)))
                        }
                    }
                }
                Spacer(minLength: 0)
                Button {
                    confirmingDelete = true
                } label: {
                    Image(systemName: "trash")
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.35), in: Circle())
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 48)
            .padding(.bottom, 16)
            .background(LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom))

            GeometryReader { proxy in
                Rectangle()
                    .fill(Color.pink)
                    .frame(width: proxy.size.width * (isActive ? min(max(pool.progress, 0), 1) : 0))
            }
            .frame(height: 2)
            .background(Color.white.opacity(0.15))
        }
        .foregroundStyle(.white)
        .safeAreaPadding(.bottom)
    }

    private var sourceLabel: String {
        var text = "元動画"
        if let start = clip.source?.startSeconds, start > 0 {
            text += " \(Self.formatTime(start))〜"
        }
        if let title = clip.source?.title ?? clip.source?.url?.host() {
            text += " \(title)"
        }
        return text
    }

    static func formatTime(_ seconds: Int) -> String {
        let h = seconds / 3600, m = seconds % 3600 / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer
    let fill: Bool

    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
        view.playerLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
    }
}

struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.title
            configuration.icon.font(.caption2.weight(.bold))
        }
    }
}
