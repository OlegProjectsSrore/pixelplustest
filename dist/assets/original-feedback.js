// TODO: app
var FeedbackForm = function (element, options) {
    if (typeof element === 'undefined') {
        return;
    }

    options = (typeof options === 'object') ? options : {};

    var defaults = {
        language: 'ru',
        eventNamespace: '.pxForm',
        maskPhoneCodes: '/assets/9bc69d3a4066-phone-codes.json',
        validation: {
            phone: {
                expression: '^\\+\\d{1,3}[^_]+$',
                message: {
                    ru: 'Указанный вами телефонный номер не используется, просьба указать корректный номер, для того, чтобы менеджеры «Пиксель Плюс» могли оперативно связаться с вами.',
                    en: 'The phone number you provided is not used, please provide the correct number so that our managers can quickly contact you.'
                }
            },
            email: {
                expression: '^([A-Za-zА-Яа-я0-9+?_\\-.])+@([A-Za-zА-Яа-я0-9_\\-.])+\\.([A-Za-zА-Яа-я]{2,10})$',
                message: {
                    ru: 'Просьба указать корректный адрес электронной почты (e-mail). Пример верного формата: manager@pixelplus.ru.',
                    en: 'Please provide a valid email address. An example of the correct format: manager@pixelplus.com.'
                }
            }
        }
    };

    this.element = $(element);
    this.options = $.extend({}, defaults, options);

    this.init = function () {
        this.options.language = (this.element.attr('data-language') !== this.options.language)
            ? this.element.attr('data-language')
            : this.options.language;

        this.validationErrors = [];

        this.form = this.element.find('form');

        this.fakeSelect = this.form.find('.fake-select');
        this.fakeSelectText = this.fakeSelect.find('.js-fake-select__text');
        this.fakeSelectDropdown = this.fakeSelect.find('.fake-select__dropdown');

        this.themeInput = this.form.find('input[name*="THEME"]');

        this.partnerInput = this.form.find('input[name*="PARTNER_REQUEST"]');

        this.phoneInput = this.form.find('input[type="tel"]:not(.field-text__input), input[name$="_PHONE"]:not(.field-text__input)');
        this.emailInput = this.form.find('input[type="email"], input[name$="_EMAIL"]');

        this.applyCustomPlugins();
        if (this.partnerInput.length > 0) {
            this.partnersUtm();
        }
        this.toggleBudgetSlider();
        this.enablePrivacyPolicy();
        this.addEventListeners();

        this.yandexMetrikaWatcher();

        // Прокрутка к форме в случае ошибки или успешной отправки
        if (this.element.hasClass('form--error') || this.element.hasClass('form--success')) {
            setTimeout($.proxy(function () {
                $('html, body').animate({
                    scrollTop: this.element.parent().offset().top - $('.header-wr').outerHeight()
                }, 0);
            }, this), 50);
        }
    };

    /** Переинициализация */
    this.reInit = function () {
        this.destroy();
        this.init();
    };

    /** Уничтожение */
    this.destroy = function () {
        this.destroyCustomPlugins();
        this.removeEventListeners();
    };

    /** Яндекс Метрика */
    // TODO: разные темы - разные цели, также может зависеть от класса формы
    this.yandexMetrikaWatcher = function() {
        if (typeof metricsEventHandler !== 'undefined' && this.element.hasClass('form--success')) {
            metricsEventHandler('ONLINE');
        }
    };

    /** Применяем сторонние плагины */
    this.applyCustomPlugins = function () {
        if (typeof $.fn.filestyle === 'function') {
            this.form.find('input[type="file"]').filestyle({
                lang: this.options.language,
                multiple: true,
                languages: {
                  'ru': {
                    browseText: 'Выберите файл',
                    placeholderText: 'Файл не выбран',
                    removeText: '<span class="icon-trash-bin"></span>'
                  },
                  'en': {
                    browseText: 'Choose file',
                    placeholderText: 'No file chosen',
                    removeText: '<span class="icon-trash-bin"></span>'
                  },
                  'es': {
                    browseText: 'Adjuntar archivo',
                    placeholderText: 'El archivo no est&#225; seleccionado',
                    removeText: '<span class="icon-trash-bin"></span>'
                  }
                }
            });
        }

        if (typeof $.fn.styler === 'function') {
            this.form.find('select.form__input').styler();
        }

        this.applyPhoneMask();
    };

    /** Уничтожаем сторонние плагины */
    this.destroyCustomPlugins = function () {
        if (typeof $.fn.filestyle === 'function') {
            this.form.find('input[type="file"]').filestyle('destroy');
        }

        if (typeof $.fn.styler === 'function') {
            this.form.find('select').styler('destroy');
        }
    };

    this.enablePrivacyPolicy = function () {
        var privacyPolicy = this.form.find('input[name*="PRIVACY_POLICY"]');
        privacyPolicy.prop('checked', true);
        privacyPolicy.trigger('refresh');
    };

    /** Добавляем обработчики событий */
    this.addEventListeners = function () {
        this.form.find('input, select').on('input change' + this.options.eventNamespace, this.removeFieldErrors.bind(this));

        this.phoneInput.on('focusout' + this.options.eventNamespace, this.validate.bind(this, 'phone'));
        this.emailInput.on('focusout' + this.options.eventNamespace, this.validate.bind(this, 'email'));

        this.fakeSelectDropdown.find('.js-theme-other').on('change' + this.options.eventNamespace, this.selectOtherThemes.bind(this));
        this.themeInput.on('change' + this.options.eventNamespace, this.toggleBudgetSlider.bind(this));
        this.partnerInput.on('change' + this.options.eventNamespace, this.partnersUtm.bind(this));
        this.themeInput.not('.js-theme-other').on('change' + this.options.eventNamespace, this.deselectOtherThemes.bind(this));
    };

    /** Удаляем обработчики событий */
    this.removeEventListeners = function () {
        this.form.find('input, select, textarea').off(this.options.eventNamespace);
    };

    /** UTM-метка партнёра */
    this.partnersUtm = function (event) {
        var checked = event ? event.target.checked : this.partnerInput[0].checked;
        if (checked) {
            $('.form__field--partner').animate({height: 'show'}, 300);
            $('.form__field--partner').find('input').prop('required',true);
        } else {
            $('.form__field--partner').animate({height: 'hide'}, 300);
            $('.form__field--partner').find('input').prop('required',false);
        }
    };

    /** Слайдер бюджета */
    this.toggleBudgetSlider = function (event) {
        var field = this.form.find('.form__field--budget');

        if (!field.length) return;

        var selectedTheme = this.themeInput.filter(':checked');
        var budgetSlider = this.form.find('.form__budget-slider');
        var budgetInput = this.form.find('input[name$="BUDGET"]');

        if (selectedTheme.length > 1 || selectedTheme.data('slider-enabled') !== true) {
            field.slideUp(300, function () {
                if (typeof budgetSlider.slider('instance') !== 'undefined') {
                    budgetSlider.slider('destroy');
                }

                budgetInput.val('');
            });
        } else {
            var sliderValues = {
                min: 0,
                max: 1
            };

            var budgetValue = budgetInput.val();

            if (typeof event === 'undefined' && budgetValue.length > 0) {
                budgetValue = budgetValue.replace(/\s/g, '').split('-');

                sliderValues.min = parseInt(budgetValue[0]);
                sliderValues.max = parseInt(budgetValue[1]);
            } else {
                sliderValues.min = parseInt(selectedTheme.data('slider-value-min'));
                sliderValues.max = parseInt(selectedTheme.data('slider-value-max'));
            }

            budgetSlider.slider({
                range: true,
                min: selectedTheme.data('slider-limit-min'),
                max: selectedTheme.data('slider-limit-max'),
                step: selectedTheme.data('slider-step'),
                values: [
                    sliderValues.min,
                    sliderValues.max
                ],
                create: function() {
                    budgetInput.val(window.pixelplusTest.numberFormat(sliderValues.min, 0, '.', ' ') + ' - ' + window.pixelplusTest.numberFormat(sliderValues.max, 0, '.', ' '));
                    budgetInput.trigger('change');
                    field.slideDown(300);
                },
                change: function(event, ui) {
                    var budget = {
                        min: window.pixelplusTest.numberFormat(ui.values[0], 0, '.', ' '),
                        max: window.pixelplusTest.numberFormat(ui.values[1], 0, '.', ' ')
                    };

                    budgetInput.val(budget.min + ' - ' + budget.max);
                    budgetInput.trigger('change');
                },
                slide: function(event, ui) {
                    var budget = {
                        min: window.pixelplusTest.numberFormat(ui.values[0], 0, '.', ' '),
                        max: window.pixelplusTest.numberFormat(ui.values[1], 0, '.', ' ')
                    };

                    budgetInput.val(budget.min + ' - ' + budget.max);
                    budgetInput.trigger('change');
                }
            });
        }
    };

    /** Снимаем выбор тем из категории "Другое" при выборе основной темы */
    this.deselectOtherThemes = function () {
        this.fakeSelect.removeClass('is-selected');
        this.fakeSelectText.text(this.fakeSelectText.data('default-text'));
        this.fakeSelectText.text(this.fakeSelectText.data('default-text'));
    };

    /** Удаления ошибок поля при вводе значения */
    this.removeFieldErrors = function (event) {
        var input = $(event.target);
        var field = input.closest('.form__field');

        if (input.val().length > 0) {
            field.removeClass('form__error');
            field.find('.form__error-text').not('.form__error-text--restricted').slideUp(200, function() {
                $(this).remove();
            });
        }
    };

    /** Валидация поля */
    this.validate = function (fieldType, event) {
        if (typeof this.options.validation[fieldType].expression === 'undefined') {
            return;
        }

        var input = $(event.target);
        var inputValue = input.val().trim();
        var field = input.closest('.form__field');

        var regEx = new RegExp(this.options.validation[fieldType].expression);

        var errorField = field.find('.form__error-text');
        var newErrorFieldHtml = '<div class="form__error-text form__error-text--restricted"></div>';
        var validationErrorIndex = this.validationErrors.indexOf(fieldType);

        // Для исключения маски телефона
        var checkedMask = fieldType === 'email' || (input.attr('value') !== inputValue.replace(/\D/g, ''));

        if (inputValue.length > 0 && checkedMask) {
            if (regEx.test(inputValue) === false) {
                if (validationErrorIndex === -1) {
                    this.validationErrors.push(fieldType);
                }

                if (errorField.length === 0) {
                    var newErrorField = $(newErrorFieldHtml);
                    field.append(newErrorField.text(this.options.validation[fieldType].message[this.options.language]));
                    newErrorField.slideDown(200);
                } else {
                    errorField.text(this.options.validation[fieldType].message[this.options.language]);
                }

                field.addClass('form__error');
            } else {
                if (validationErrorIndex > -1) {
                    this.validationErrors.splice(validationErrorIndex, 1);
                }

                field.removeClass('form__error');
                field.find('.form__error-text').slideUp(200, function () {
                    $(this).remove();
                });
            }
        }

        if (this.validationErrors.length > 0) {
            this.form.find('.form__submit').prop('disabled', true);
        } else {
            this.form.find('.form__submit').prop('disabled', false);
        }
    };

    /** Выбор темы из категории "Другое" */
    this.selectOtherThemes = function () {
        this.fakeSelect.find('input[type="checkbox"][value="OTHER"]').prop('checked', false);

        var otherThemes = this.fakeSelectDropdown.find('.js-theme-other:checked');
        var otherThemesArr = [];
        var otherThemesStr = '';

        if (otherThemes.length > 0) {
            this.fakeSelect.addClass('is-selected');

            otherThemes.each(function (index, element) {
                otherThemesArr.push($(element).closest('.form__label').text().trim());
            });

            otherThemesArr.map(function (currentValue, index, array) {
                if (index > 0) {
                    array[index] = currentValue.toLowerCase();
                }
            });

            otherThemesStr = otherThemesArr.join(', ');

            this.fakeSelectText.text(otherThemesStr);

            if (otherThemes.length > 1) {
                this.fakeSelectText.attr('title', otherThemesStr);
            }
        } else {
            this.fakeSelect.removeClass('is-selected');
            this.fakeSelectText.text(this.fakeSelectText.data('default-text'));
            this.fakeSelectText.attr('title', '');
        }
    };

    /** Маска для телефона с выбором страны из выпадающего списка */
    this.applyPhoneMask = function () {
        if (typeof $.fn.inputmask !== 'function') {
            console.warn('RobinHerbots/Inputmask plugin is required');
            return;
        }

        if (typeof $.fn.inputmasks !== 'function') {
            console.warn('andr-04/inputmask-multi plugin is required');
            return;
        }

        var context = this;

        if (this.phoneInput.length > 0) {
            var maskList = $.masksSort($.masksLoad(this.options.maskPhoneCodes), ['#'], /[0-9]|#/, 'mask');
            var maskOpts = {
                inputmask: {
                    definitions: {
                        '#': {
                            validator: '[0-9]',
                            cardinality: 1
                        }
                    },
                    positionCaretOnTab: true,
                    oncomplete: function () {
                        context.phoneInput.trigger('phonechange');
                    }
                },
                match: /[0-9]/,
                replace: '#',
                list: maskList,
                listKey: 'mask'
            };

            this.phoneInput.inputmasks(maskOpts);

            var callingCodesSelect = this.form.find('select[name="COUNTRY_CALLING_CODES"]');

            if (callingCodesSelect.length > 0) {
                callingCodesSelect.on('change' + this.options.eventNamespace, function () {
                    context.phoneInput.val($(this).find('option:selected').data('calling-code'));
                    context.phoneInput.trigger('click');
                    context.phoneInput.trigger('focus');
                });
            }
        }
    };

    this.init();
};
