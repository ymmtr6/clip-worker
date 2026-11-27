import AVFoundation
import SwiftUI

/// 一覧。3列のサムネイルで、タップするとその動画からフィードを再生する
struct ClipGridView: View {
    let clips: [Clip]
    let onSelect: (String) -> Void
    /// 末尾近くまでスクロールしたら次のページを読む
    let onReachEnd: () -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(Array(clips.enumerated()), id: \.element.id) { index, clip in
                    Button { onSelect(clip.id) } label: { ClipThumbnail(clip: clip) }
                        .buttonStyle(.plain)
                        .onAppear { if index >= clips.count - 6 { onReachEnd() } }
                }
            }
            .padding(.top, 60)
        }
        .scrollIndicators(.hidden)
        .background(Color.black)
    }
}

private struct ClipThumbnail: View {
    let clip: Clip
    @State private var frame: UIImage?

    var body: some View {
        Color(white: 0.1)
            .aspectRatio(9 / 16, contentMode: .fit)
            .overlay { image }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(clip.title)
                        .font(.caption.weight(.semibold))
                        .lineLimit(2)
                    Label("\(clip.viewCount)", systemImage: "play.fill")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.8))
                }
                .foregroundStyle(.white)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom))
            }
            .clipped()
            .contentShape(Rectangle())
            .task(id: clip.id) {
                if clip.posterUrl == nil { frame = await Thumbnails.image(for: clip) }
            }
    }

    @ViewBuilder
    private var image: some View {
        if let poster = clip.posterUrl {
            AsyncImage(url: poster) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.clear
            }
        } else if let frame {
            Image(uiImage: frame).resizable().scaledToFill()
        }
    }
}

/// ポスターの無い動画は先頭付近のフレームを切り出して使う
@MainActor
private enum Thumbnails {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(for clip: Clip) async -> UIImage? {
        if let cached = cache.object(forKey: clip.id as NSString) { return cached }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: clip.videoUrl))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 360, height: 640)
        guard let result = try? await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)) else { return nil }
        let image = UIImage(cgImage: result.image)
        cache.setObject(image, forKey: clip.id as NSString)
        return image
    }
}
