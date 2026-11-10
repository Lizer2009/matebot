package com.matebot.pdfview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A PDF drawn with the system PdfRenderer; Android's WebView cannot show one. */
class MatebotPdfViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MatebotPdfView")

    View(MatebotPdfView::class) {
      Events("onLoadError")
      Prop("uri") { view: MatebotPdfView, uri: String -> view.load(uri) }
      OnViewDestroys { view: MatebotPdfView -> view.release() }
    }
  }
}
